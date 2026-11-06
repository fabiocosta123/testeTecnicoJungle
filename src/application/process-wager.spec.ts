import { describe, expect, it } from 'bun:test';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { LedgerDirection } from '../domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { IdSource } from './open-wallet.js';
import {
  IdempotencyConflictError,
  InboxConflictError,
  ProcessWager,
  ProcessWagerCommand,
  SavedWager,
  WagerStore,
  WagerTx,
} from './process-wager.js';

const at = new Date('2026-11-06T08:00:00.000Z');
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function ids(...values: string[]): IdSource {
  const queue = [...values];
  return {
    next() {
      const id = queue.shift();
      if (!id) {
        throw new Error('no more ids');
      }
      return id;
    },
  };
}

function wallet(amount: string): Wallet {
  return Wallet.rehydrate({
    id: walletId,
    playerId,
    balance: brl(amount),
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
}

function bet(
  amount: string,
  externalTransactionId = 'transaction-123',
): ProcessWagerCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl(amount),
    at,
  };
}

class MemoryWagerStore implements WagerStore {
  wallet?: Wallet;
  readonly saved: SavedWager[] = [];
  private readonly byKey = new Map<string, SavedWager['transaction']>();
  private readonly inbox = new Map<string, string>();

  async transact<T>(
    walletId: string,
    work: (tx: WagerTx) => Promise<T>,
  ): Promise<T> {
    return work({
      findByIdempotencyKey: async (key) => this.byKey.get(key),
      findByExternalId: async (providerId, externalTransactionId) =>
        this.find(
          (transaction) =>
            transaction.providerId === providerId &&
            transaction.externalTransactionId === externalTransactionId,
        ),
      findActiveReversal: async (providerId, referenceExternalTransactionId) =>
        this.find(
          (transaction) =>
            transaction.providerId === providerId &&
            transaction.referenceExternalTransactionId ===
              referenceExternalTransactionId &&
            (transaction.kind === WagerTransactionKind.Refund ||
              transaction.kind === WagerTransactionKind.Rollback) &&
            (transaction.status === WagerTransactionStatus.Pending ||
              transaction.status === WagerTransactionStatus.PendingReference ||
              transaction.status === WagerTransactionStatus.Processed),
        ) !== undefined,
      markInbox: async (receipt) => {
        const key = `${receipt.consumerName}\0${receipt.messageId}`;
        const previous = this.inbox.get(key);
        if (previous === undefined) {
          this.inbox.set(key, receipt.payloadHash);
          return 'recorded';
        }
        if (previous !== receipt.payloadHash) {
          throw new InboxConflictError();
        }
        return 'duplicate';
      },
      lockWallet: async (id) => (id === walletId ? this.wallet : undefined),
      save: async (saved) => {
        this.byKey.set(saved.transaction.idempotencyKey, saved.transaction);
        this.wallet = saved.wallet;
        this.saved.push(saved);
      },
    });
  }

  private find(
    matches: (transaction: WagerTransaction) => boolean,
  ): WagerTransaction | undefined {
    for (const transaction of this.byKey.values()) {
      if (matches(transaction)) {
        return transaction;
      }
    }
    return undefined;
  }
}

describe('ProcessWager', () => {
  it('debits a bet and records the balance that was seen', async () => {
    const store = new MemoryWagerStore();
    store.wallet = wallet('100.00');
    const useCase = new ProcessWager(
      store,
      ids(
        '0192f298-345e-7e38-af88-e43f851a819d',
        '0192f298-345e-7e38-af88-e43f851a819e',
        '0192f298-345e-7e38-af88-e43f851a819f',
        '0192f298-345e-7e38-af88-e43f851a81a0',
      ),
    );

    const result = await useCase.execute(bet('25.00'));
    const saved = store.saved[0];

    expect(result.idempotentReplay).toBe(false);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.equals(brl('75.00'))).toBe(true);
    expect(saved.wallet.version).toBe(2);
    expect(saved.entry?.direction).toBe(LedgerDirection.Debit);
    expect(saved.events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('rejects a bet that would make the balance negative', async () => {
    const store = new MemoryWagerStore();
    store.wallet = wallet('50.00');
    const useCase = new ProcessWager(
      store,
      ids(
        '0192f298-345e-7e38-af88-e43f851a819d',
        '0192f298-345e-7e38-af88-e43f851a819e',
      ),
    );

    const result = await useCase.execute(bet('80.00'));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(result.balance.equals(brl('50.00'))).toBe(true);
    expect(store.wallet?.version).toBe(1);
    expect(store.saved[0].entry).toBeUndefined();
    expect(store.saved[0].events.map((event) => event.eventType)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  it('returns the original result when the same key and payload arrive again', async () => {
    const store = new MemoryWagerStore();
    store.wallet = wallet('100.00');
    const keys = ids(
      '0192f298-345e-7e38-af88-e43f851a819d',
      '0192f298-345e-7e38-af88-e43f851a819e',
      '0192f298-345e-7e38-af88-e43f851a819f',
      '0192f298-345e-7e38-af88-e43f851a81a0',
    );
    const useCase = new ProcessWager(store, keys);

    await useCase.execute(bet('25.00'));
    const replay = await useCase.execute(bet('25.00'));

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.equals(brl('75.00'))).toBe(true);
    expect(store.saved).toHaveLength(1);
    expect(store.wallet?.balance.equals(brl('75.00'))).toBe(true);
  });

  it('rejects the same key when the payload changed', async () => {
    const store = new MemoryWagerStore();
    store.wallet = wallet('100.00');
    const useCase = new ProcessWager(
      store,
      ids(
        '0192f298-345e-7e38-af88-e43f851a819d',
        '0192f298-345e-7e38-af88-e43f851a819e',
        '0192f298-345e-7e38-af88-e43f851a819f',
        '0192f298-345e-7e38-af88-e43f851a81a0',
      ),
    );

    await useCase.execute(bet('25.00'));

    await expect(useCase.execute(bet('30.00'))).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect(store.saved).toHaveLength(1);
  });
});
