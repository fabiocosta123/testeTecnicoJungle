import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  NotFoundException,
  Post,
  Res,
} from '@nestjs/common';
import { InvalidMoneyError, Money } from '../domain/money.js';
import {
  InvalidTransactionStateError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import {
  IdempotencyConflictError,
  ProcessWager,
  WagerNotFoundError,
  WagerResult,
} from '../application/process-wager.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const acceptedKinds = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

interface SubmitBody {
  providerId?: string;
  externalTransactionId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  gameId?: string;
  kind?: string;
  money?: { amount?: string; currency?: string };
  referenceExternalTransactionId?: string;
}

interface HttpReply {
  status(code: number): { json(body: unknown): void };
}

@Controller('wagering')
export class WageringController {
  constructor(private readonly processWager: ProcessWager) {}

  @Post('transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Body() body: SubmitBody,
    @Res() reply: HttpReply,
  ) {
    const key = headerValue(idempotencyKey)?.trim();
    const amount = body?.money?.amount;
    const currency = body?.money?.currency;
    const reference = body?.referenceExternalTransactionId?.trim();

    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    if (
      !body?.providerId?.trim() ||
      !body.externalTransactionId?.trim() ||
      !body.playerId ||
      !uuid.test(body.playerId) ||
      !body.walletId ||
      !uuid.test(body.walletId) ||
      !body.roundId?.trim() ||
      !body.gameId?.trim() ||
      !body.kind ||
      !acceptedKinds.has(body.kind) ||
      !amount ||
      !currency
    ) {
      throw new BadRequestException(
        'provider, player, wallet, round, game, kind and money are required',
      );
    }

    try {
      const result = await this.processWager.execute({
        providerId: body.providerId.trim(),
        externalTransactionId: body.externalTransactionId.trim(),
        idempotencyKey: key,
        playerId: body.playerId,
        walletId: body.walletId,
        roundId: body.roundId.trim(),
        gameId: body.gameId.trim(),
        kind: body.kind as WagerTransactionKind,
        referenceExternalTransactionId: reference || undefined,
        money: Money.from({ amount, currency }),
        at: new Date(),
      });

      reply.status(statusFor(result)).json(toResponse(result));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException(error.message);
      }

      if (error instanceof WagerNotFoundError) {
        throw new NotFoundException(error.message);
      }

      if (
        error instanceof InvalidMoneyError ||
        error instanceof InvalidTransactionStateError
      ) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function statusFor(result: WagerResult): number {
  // 202 ainda espera a aposta; 422 já recusou e não deve ser reenviado como se o payload fosse outro
  if (result.status === WagerTransactionStatus.Processed) {
    return 200;
  }
  if (result.status === WagerTransactionStatus.PendingReference) {
    return 202;
  }
  if (result.status === WagerTransactionStatus.Rejected) {
    return 422;
  }

  throw new Error(`unexpected wager status ${result.status}`);
}

function toResponse(result: WagerResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    balance: result.balance.toJSON(),
    idempotentReplay: result.idempotentReplay,
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
  };
}
