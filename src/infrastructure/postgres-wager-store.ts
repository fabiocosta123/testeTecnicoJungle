import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager, type SqlEntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import {
  IdempotencyConflictError,
  InboxConflictError,
  InboxReceipt,
  SavedWager,
  WagerStore,
  WagerTx,
} from '../application/process-wager.js';

@Injectable()
export class PostgresWagerStore implements WagerStore {
  constructor(private readonly em: EntityManager) {}

  async transact<T>(
    walletId: string,
    work: (tx: WagerTx) => Promise<T>,
  ): Promise<T> {
    try {
      // a trava dura o commit inteiro: duas apostas da mesma carteira não debitam juntas
      return await this.em.transactional(
        async (em) => work(new PostgresWagerTx(em)),
        { clear: true },
      );
    } catch (error) {
      if (isIdempotencyConflict(error)) {
        throw new IdempotencyConflictError();
      }

      throw error;
    }
  }
}

class PostgresWagerTx implements WagerTx {
  constructor(private readonly em: SqlEntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute<WalletRow[]>(
      `select id, player_id, currency, balance_amount::text as balance_amount,
            version, created_at, updated_at
            from wallets
            where id = ?
            for update`,
      [walletId],
      'all',
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      balance: Money.from({
        amount: row.balance_amount,
        currency: row.currency,
      }),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne('idempotency_key = ?', [key]);
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne('provider_id = ? and external_transaction_id = ?', [
      providerId,
      externalTransactionId,
    ]);
  }

  async findActiveReversal(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<boolean> {
    // rejeitada não ocupa a vaga: só pendente ou processada trava outro estorno
    const rows = await this.em.execute<{ id: string }[]>(
      `select id from wager_transactions
       where provider_id = ?
         and reference_external_transaction_id = ?
         and kind in ('REFUND', 'ROLLBACK')
         and status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
       limit 1`,
      [providerId, referenceExternalTransactionId],
      'all',
    );
    return rows.length > 0;
  }

  async markInbox(receipt: InboxReceipt): Promise<'recorded' | 'duplicate'> {
    const inserted = await this.em.execute<Array<{ message_id: string }>>(
      `insert into inbox_messages (
         consumer_name, message_id, payload_hash, received_at
       ) values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [
        receipt.consumerName,
        receipt.messageId,
        receipt.payloadHash,
        receipt.receivedAt,
      ],
      'all',
    );
    if (inserted.length > 0) {
      return 'recorded';
    }

    const rows = await this.em.execute<Array<{ payload_hash: string }>>(
      `select payload_hash from inbox_messages
       where consumer_name = ? and message_id = ?`,
      [receipt.consumerName, receipt.messageId],
      'all',
    );
    if (rows[0]?.payload_hash !== receipt.payloadHash) {
      throw new InboxConflictError();
    }
    return 'duplicate';
  }

  private async findOne(
    whereSql: string,
    params: unknown[],
  ): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<WagerRow[]>(
      `select id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount::text as amount,
       currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code,
       result_balance_amount::text as result_balance_amount,
       result_balance_currency, created_at, processed_at
    from wager_transactions
    where ${whereSql}`,
      params,
      'all',
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      referenceExternalTransactionId:
        row.reference_external_transaction_id ?? undefined,
      createdAt: row.created_at,
      status: row.status,
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      failureCode: row.failure_code ?? undefined,
      processedAt: row.processed_at ?? undefined,
      resultBalance:
        row.result_balance_amount && row.result_balance_currency
          ? Money.from({
              amount: row.result_balance_amount,
              currency: row.result_balance_currency,
            })
          : undefined,
    });
  }

  async save(saved: SavedWager): Promise<void> {
    if (saved.entry) {
      const balance = saved.wallet.balance.toJSON();
      await this.em.execute(
        `update wallets
         set balance_amount = ?, version = ?, updated_at = ?
         where id = ?`,
        [
          balance.amount,
          saved.wallet.version,
          saved.wallet.updatedAt,
          saved.wallet.id,
        ],
        'run',
      );
    }
    const amount = saved.transaction.money.toJSON();
    const result = saved.transaction.resultBalance?.toJSON();
    await this.em.execute(
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         reference_external_transaction_id, reference_transaction_id,
         status, failure_code, result_balance_amount, result_balance_currency,
         created_at, processed_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        saved.transaction.id,
        saved.transaction.providerId,
        saved.transaction.externalTransactionId,
        saved.transaction.idempotencyKey,
        saved.transaction.payloadHash,
        saved.transaction.walletId,
        saved.transaction.playerId,
        saved.transaction.roundId,
        saved.transaction.gameId,
        saved.transaction.kind,
        amount.amount,
        amount.currency,
        saved.transaction.referenceExternalTransactionId ?? null,
        saved.transaction.referenceTransactionId ?? null,
        saved.transaction.status,
        saved.transaction.failureCode ?? null,
        result?.amount ?? null,
        result?.currency ?? null,
        saved.transaction.createdAt,
        saved.transaction.processedAt ?? null,
      ],
      'run',
    );
    if (saved.entry) {
      const movement = saved.entry.money.toJSON();
      const before = saved.entry.balanceBefore.toJSON();
      const after = saved.entry.balanceAfter.toJSON();
      await this.em.execute(
        `insert into wallet_ledger_entries (
           id, wallet_id, currency, transaction_id, direction, amount,
           balance_before, balance_after, created_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          saved.entry.id,
          saved.entry.walletId,
          movement.currency,
          saved.entry.transactionId,
          saved.entry.direction,
          movement.amount,
          before.amount,
          after.amount,
          saved.entry.createdAt,
        ],
        'run',
      );
    }
    for (const event of saved.events) {
      await this.em.execute(
        `insert into outbox_messages (
           id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
         ) values (?, ?, ?, ?::jsonb, ?, 0, ?)`,
        [
          event.eventId,
          event.aggregateId,
          event.eventType,
          JSON.stringify(event.toJSON()),
          event.occurredAt,
          event.occurredAt,
        ],
        'run',
      );
    }
  }
}
interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface WagerRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerTransactionStatus;
  failure_code: FailureCode | null;
  result_balance_amount: string | null;
  result_balance_currency: string | null;
  created_at: Date;
  processed_at: Date | null;
}
function isIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof UniqueConstraintViolationException)) {
    return false;
  }
  return (
    (error as { constraint?: string }).constraint ===
    'wager_transactions_idempotency_key_unique'
  );
}
