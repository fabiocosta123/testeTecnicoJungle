import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import {
  WalletAlreadyExistsError,
  WalletOpened,
  WalletStore,
} from '../application/open-wallet.js';

@Injectable()
export class PostgresWalletStore implements WalletStore {
  constructor(private readonly em: EntityManager) { }

  async saveOpening(opened: WalletOpened): Promise<void> {
    if (Boolean(opened.opening) !== Boolean(opened.entry)) {
      throw new Error(
        'opening transaction and ledger entry must be saved together',
      );
    }

    try {
      // o saldo e o ledger são conferidos juntos no fim da transação
      await this.em.transactional(async (em) => {
        const balance = opened.wallet.balance.toJSON();

        await em.execute(
          `insert into wallets (
                        id, player_id, currency, balance_amount, version, created_at, updated_at
                    ) values (?, ?, ?, ?, ?, ?, ?)`,
          [
            opened.wallet.id,
            opened.wallet.playerId,
            opened.wallet.currency,
            balance.amount,
            opened.wallet.version,
            opened.wallet.createdAt,
            opened.wallet.updatedAt,
          ],
          'run',
        );

        if (opened.opening && opened.entry) {
          const amount = opened.opening.money.toJSON();
          const result = opened.opening.resultBalance?.toJSON();
          const processedAt = opened.opening.processedAt;

          if (!result || !processedAt) {
            throw new Error('opening must store the processed balance');
          }

          await em.execute(
            `insert into wager_transactions (
                        id, provider_id, external_transaction_id, idempotency_key, payload_hash, 
                        wallet_id, player_id, round_id, game_id, kind, amount, currency,
                        status, result_balance_amount, result_balance_currency, created_at, processed_at
                        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              opened.opening.id,
              opened.opening.providerId,
              opened.opening.externalTransactionId,
              opened.opening.idempotencyKey,
              opened.opening.payloadHash,
              opened.opening.walletId,
              opened.opening.playerId,
              opened.opening.roundId,
              opened.opening.gameId,
              opened.opening.kind,
              amount.amount,
              amount.currency,
              opened.opening.status,
              result.amount,
              result.currency,
              opened.opening.createdAt,
              processedAt,
            ],
            'run',
          );

          const movement = opened.entry.money.toJSON();
          const before = opened.entry.balanceBefore.toJSON();
          const after = opened.entry.balanceAfter.toJSON();

          await em.execute(
            `insert into wallet_ledger_entries (
                        id, wallet_id, currency, transaction_id, direction, amount, balance_before,
                        balance_after, created_at
                        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              opened.entry.id,
              opened.entry.walletId,
              movement.currency,
              opened.entry.transactionId,
              opened.entry.direction,
              movement.amount,
              before.amount,
              after.amount,
              opened.entry.createdAt,
            ],
            'run',
          );
        }

        // await em.execute(
        //   `insert into outbox_messages (
        //                 id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
        //             ) values (?, ?, ?, ?::jsonb, ?, 0, ?)`,
        //   [
        //     opened.event.id,
        //     opened.event.walletId,
        //     opened.event.eventType,
        //     JSON.stringify(opened.event.payload),
        //     opened.event.occurredAt,
        //     opened.event.occurredAt,
        //   ],
        //   'run',
        // );

        for (const event of opened.events) {
          await em.execute(
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
      });
    } catch (error) {
      if (isSamePlayerAndCurrency(error)) {
        throw new WalletAlreadyExistsError();
      }

      throw error;
    }
  }
}

function isSamePlayerAndCurrency(error: unknown): boolean {
  if (!(error instanceof UniqueConstraintViolationException)) {
    return false;
  }

  return (
    (error as { constraint?: string }).constraint ===
    'wallets_player_currency_unique'
  );
}
