import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Money } from '../domain/money.js';
import { OpenWallet } from '../application/open-wallet.js';
import { ProcessWager } from '../application/process-wager.js';
import { WagerTransactionKind } from '../domain/wager-transaction.js';
import databaseConfig from '../database/mikro-orm.config.js';
import { PostgresWalletStore } from '../infrastructure/postgres-wallet-store.js';
import { PostgresWagerStore } from '../infrastructure/postgres-wager-store.js';
import {
  CONSUMER_NAME,
  createSqsClient,
  ensureQueues,
  handleDelivery,
  publishMessage,
  QueueUrls,
  receiveOne,
  settleDelivery,
} from './sqs.js';

const at = new Date('2026-11-06T10:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('sqs consumer', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let client: SQSClient;
  let queues: QueueUrls;

  beforeAll(async () => {
    orm = await MikroORM.init(databaseConfig);
    em = orm.em.fork();
    client = createSqsClient();
    const id = randomUUID();
    queues = await ensureQueues(client, {
      wager: `it-${id}.fifo`,
      dlq: `it-${id}-dlq.fifo`,
    });
  });

  afterAll(async () => {
    client.destroy();
    await orm.close();
  });

  it('debits once when the same sqs message is delivered twice', async () => {
    const wallet = await openWallet('100.00');
    const externalTransactionId = randomUUID();
    const messageId = randomUUID();
    const body = messageBody(wallet, externalTransactionId, messageId, '25.00');

    await publishMessage(client, queues.wagerUrl, body, wallet.id, messageId);
    const first = await receiveOne(client, queues.wagerUrl, 5);
    const second = await redeliver(first, body);

    const balance = await readBalance(wallet.id);
    const ledger = await count(
      `select count(*)::text as total from wallet_ledger_entries where wallet_id = ?`,
      wallet.id,
    );
    const debits = await count(
      `select count(*)::text as total
       from wallet_ledger_entries
       where wallet_id = ? and direction = 'DEBIT'`,
      wallet.id,
    );
    const inbox = await count(
      `select count(*)::text as total from inbox_messages
       where consumer_name = ? and message_id = ?`,
      CONSUMER_NAME,
      messageId,
    );

    expect(first?.Body).toBe(body);
    expect(second.outcome1).toBe('ack');
    expect(second.outcome2).toBe('ack');
    expect(balance[0].balance_amount).toBe('75.00');
    expect(balance[0].version).toBe(2);
    expect(ledger).toBe('2');
    expect(debits).toBe('1');
    expect(inbox).toBe('1');
  });

  it('acks a rejected bet and does not debit when the message comes back', async () => {
    const wallet = await openWallet('50.00');
    const externalTransactionId = randomUUID();
    const messageId = randomUUID();
    const body = messageBody(wallet, externalTransactionId, messageId, '80.00');

    await publishMessage(client, queues.wagerUrl, body, wallet.id, messageId);
    const first = await receiveOne(client, queues.wagerUrl, 5);
    const second = await redeliver(first, body);
    const wager = await em.execute<
      Array<{ status: string; failure_code: string | null }>
    >(
      `select status, failure_code from wager_transactions
       where idempotency_key = ?`,
      [`provider-a:${externalTransactionId}`],
      'all',
    );
    const debits = await count(
      `select count(*)::text as total
       from wallet_ledger_entries
       where wallet_id = ? and direction = 'DEBIT'`,
      wallet.id,
    );

    expect(second.outcome1).toBe('ack');
    expect(second.outcome2).toBe('ack');
    expect(wager[0].status).toBe('REJECTED');
    expect(wager[0].failure_code).toBe('INSUFFICIENT_BALANCE');
    expect(debits).toBe('0');
  });

  async function openWallet(amount: string) {
    return new OpenWallet(new PostgresWalletStore(em.fork()), {
      next: () => randomUUID(),
    }).execute({
      playerId: randomUUID(),
      initialBalance: brl(amount),
      openedAt: at,
    });
  }

  function messageBody(
    wallet: { id: string; playerId: string },
    externalTransactionId: string,
    messageId: string,
    amount: string,
  ): string {
    return JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: at.toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount, currency: 'BRL' },
      },
    });
  }

  async function redeliver(
    first: Awaited<ReturnType<typeof receiveOne>>,
    body: string,
  ) {
    if (!first?.Body || !first.ReceiptHandle) {
      throw new Error('queue did not return the message');
    }

    const outcome1 = await handleDelivery({
      processWager: useCase(),
      body: first.Body,
      receiveCount: 1,
    });
    await client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queues.wagerUrl,
        ReceiptHandle: first.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    const again = await receiveOne(client, queues.wagerUrl, 5);
    if (!again?.Body) {
      throw new Error('queue did not redeliver the message');
    }

    const outcome2 = await handleDelivery({
      processWager: useCase(),
      body: again.Body,
      receiveCount: 2,
    });
    await settleDelivery(client, queues, again, outcome2);
    expect(again.Body).toBe(body);
    return { outcome1, outcome2 };
  }

  function useCase(): ProcessWager {
    return new ProcessWager(new PostgresWagerStore(em.fork()), {
      next: () => randomUUID(),
    });
  }

  async function readBalance(walletId: string) {
    return em.execute<Array<{ balance_amount: string; version: number }>>(
      `select balance_amount::text as balance_amount, version from wallets where id = ?`,
      [walletId],
      'all',
    );
  }

  async function count(sql: string, ...params: string[]): Promise<string> {
    const rows = await em.execute<Array<{ total: string }>>(sql, params, 'all');
    return rows[0].total;
  }
});
