import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { InvalidMoneyError, Money } from '../domain/money.js';
import {
  InvalidTransactionStateError,
  WagerTransactionKind,
} from '../domain/wager-transaction.js';
import {
  IdempotencyConflictError,
  InboxConflictError,
  InboxReceipt,
  ProcessWager,
  ProcessWagerCommand,
} from '../application/process-wager.js';

export const CONSUMER_NAME = 'wager-transactions';
export const MAX_RECEIVES = 5;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const acceptedKinds = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export type DeliveryOutcome = 'ack' | 'retry' | 'dlq';

export interface QueueUrls {
  wagerUrl: string;
  dlqUrl: string;
}

export class PermanentMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

export async function ensureQueues(
  client: SQSClient,
  names = {
    wager: 'wager-transactions.fifo',
    dlq: 'wager-transactions-dlq.fifo',
  },
): Promise<QueueUrls> {
  const dlqUrl = await createFifo(client, names.dlq);
  const arn = await queueArn(client, dlqUrl);
  const wagerUrl = await createFifo(client, names.wager, {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: arn,
      maxReceiveCount: String(MAX_RECEIVES),
    }),
    VisibilityTimeout: '30',
  });
  return { wagerUrl, dlqUrl };
}

export async function publishMessage(
  client: SQSClient,
  queueUrl: string,
  body: string,
  groupId: string,
  deduplicationId: string,
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export async function receiveOne(
  client: SQSClient,
  queueUrl: string,
  waitSeconds: number,
): Promise<Message | undefined> {
  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitSeconds,
      VisibilityTimeout: 30,
      MessageSystemAttributeNames: [
        'ApproximateReceiveCount',
        'MessageGroupId',
      ],
    }),
  );
  return received.Messages?.[0];
}

export async function handleDelivery(input: {
  processWager: ProcessWager;
  body: string;
  receiveCount: number;
}): Promise<DeliveryOutcome> {
  try {
    const parsed = parseMessage(input.body);
    // o caso de uso commita antes deste return: o ack fica para quem chamou
    await input.processWager.execute(parsed.command, parsed.inbox);
    return 'ack';
  } catch (error) {
    if (isPermanent(error) || input.receiveCount >= MAX_RECEIVES) {
      return 'dlq';
    }
    return 'retry';
  }
}

export async function settleDelivery(
  client: SQSClient,
  queues: QueueUrls,
  message: Message,
  outcome: DeliveryOutcome,
): Promise<void> {
  if (!message.ReceiptHandle) {
    throw new Error('sqs message has no receipt handle');
  }

  if (outcome === 'ack') {
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.wagerUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
    return;
  }

  if (outcome === 'dlq') {
    await client.send(
      new SendMessageCommand({
        QueueUrl: queues.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'wager',
        MessageDeduplicationId: `${message.MessageId ?? 'missing'}-dlq`,
      }),
    );
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queues.wagerUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
    return;
  }

  const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
  const timeout = Math.min(30 * 2 ** Math.max(count - 1, 0), 300);
  await client.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queues.wagerUrl,
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: timeout,
    }),
  );
}

function parseMessage(body: string): {
  command: ProcessWagerCommand;
  inbox: InboxReceipt;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PermanentMessageError('message body is not json');
  }

  if (!isRecord(parsed) || parsed.type !== 'WagerTransactionRequested') {
    throw new PermanentMessageError('message type is not supported');
  }

  const messageId = asString(parsed.messageId);
  const occurredAt = asString(parsed.occurredAt);
  if (!messageId || !occurredAt || !isRecord(parsed.data)) {
    throw new PermanentMessageError('message envelope is incomplete');
  }

  const at = new Date(occurredAt);
  if (Number.isNaN(at.getTime())) {
    throw new PermanentMessageError('occurredAt is invalid');
  }

  const data = parsed.data;
  const kind = asString(data.kind);
  const money = isRecord(data.money) ? data.money : undefined;
  const providerId = asString(data.providerId);
  const externalTransactionId = asString(data.externalTransactionId);
  const idempotencyKey = asString(data.idempotencyKey);
  const playerId = asString(data.playerId);
  const walletId = asString(data.walletId);
  const roundId = asString(data.roundId);
  const gameId = asString(data.gameId);
  const amount = asString(money?.amount);
  const currency = asString(money?.currency);

  if (
    !providerId ||
    !externalTransactionId ||
    !idempotencyKey ||
    !playerId ||
    !uuid.test(playerId) ||
    !walletId ||
    !uuid.test(walletId) ||
    !roundId ||
    !gameId ||
    !kind ||
    !acceptedKinds.has(kind) ||
    !amount ||
    !currency
  ) {
    throw new PermanentMessageError('message data is incomplete');
  }

  const reference = asString(data.referenceExternalTransactionId);

  return {
    command: {
      providerId,
      externalTransactionId,
      idempotencyKey,
      playerId,
      walletId,
      roundId,
      gameId,
      kind: kind as WagerTransactionKind,
      referenceExternalTransactionId: reference,
      money: Money.from({ amount, currency }),
      at,
    },
    inbox: {
      consumerName: CONSUMER_NAME,
      messageId,
      payloadHash: createHash('sha256').update(body).digest('hex'),
      receivedAt: new Date(),
    },
  };
}

function isPermanent(error: unknown): boolean {
  if (
    error instanceof PermanentMessageError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidTransactionStateError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InboxConflictError
  ) {
    return true;
  }

  // carteira ausente pode chegar depois; estes códigos não mudam numa nova tentativa
  const code = (error as { code?: string }).code;
  return (
    code === '22P02' || code === '23514' || code === '23503' || code === '23505'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

async function createFifo(
  client: SQSClient,
  name: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const created = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ...extra,
      },
    }),
  );
  if (!created.QueueUrl) {
    throw new Error(`queue ${name} has no url`);
  }
  return created.QueueUrl;
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const arn = attributes.Attributes?.QueueArn;
  if (!arn) {
    throw new Error(`queue ${queueUrl} has no arn`);
  }
  return arn;
}
