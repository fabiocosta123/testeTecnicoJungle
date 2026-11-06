import { describe, expect, it } from 'bun:test';
import { Money } from '../domain/money.js';
import { LedgerDirection } from '../domain/wallet-ledger-entry.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import {
  IdSource,
  OpenWallet,
  WalletAlreadyExistsError,
  WalletOpened,
  WalletStore,
} from './open-wallet.js';

const at = new Date('2026-11-05T18:00:00.000Z');
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

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

class MemoryWalletStore implements WalletStore {
  readonly saved: WalletOpened[] = [];

  async saveOpening(opened: WalletOpened): Promise<void> {
    const exists = this.saved.some(
      (item) =>
        item.wallet.playerId === opened.wallet.playerId &&
        item.wallet.currency === opened.wallet.currency,
    );

    if (exists) {
      throw new WalletAlreadyExistsError();
    }

    this.saved.push(opened);
  }
}

describe('OpenWallet', () => {
  it('opens a positive balance with one credit and one opening transaction', async () => {
    const store = new MemoryWalletStore();
    const useCase = new OpenWallet(
      store,
      ids(
        '0192f291-27dd-7d3f-8071-5f8685deef37',
        '0192f291-27dd-7d3f-8071-5f8685deef38',
        '0192f291-27dd-7d3f-8071-5f8685deef39',
        '0192f291-27dd-7d3f-8071-5f8685deef3a',
      ),
    );

    const wallet = await useCase.execute({
      playerId,
      initialBalance: brl('1000.00'),
      openedAt: at,
    });

    const saved = store.saved[0];

    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(saved.opening?.kind).toBe(WagerTransactionKind.Opening);
    expect(saved.opening?.status).toBe(WagerTransactionStatus.Processed);
    expect(saved.opening?.providerId).toBe('internal');
    expect(saved.entry?.direction).toBe(LedgerDirection.Credit);
    expect(saved.entry?.balanceBefore.equals(brl('0.00'))).toBe(true);
    expect(saved.entry?.balanceAfter.equals(brl('1000.00'))).toBe(true);
    expect(saved.entry?.transactionId).toBe(saved.opening?.id);
    expect(saved.event.eventType).toBe('wallet.opened');
    expect(saved.event.payload.openingTransactionId).toBe(saved.opening?.id);
  });

  it('opens a zero balance without a ledger line', async () => {
    const store = new MemoryWalletStore();
    const useCase = new OpenWallet(
      store,
      ids(
        '0192f291-27dd-7d3f-8071-5f8685deef37',
        '0192f291-27dd-7d3f-8071-5f8685deef3a',
      ),
    );

    const wallet = await useCase.execute({
      playerId,
      initialBalance: brl('0.00'),
      openedAt: at,
    });

    expect(wallet.balance.equals(brl('0.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(store.saved[0].opening).toBeUndefined();
    expect(store.saved[0].entry).toBeUndefined();
    expect(store.saved[0].event.payload.openingTransactionId).toBeUndefined();
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const store = new MemoryWalletStore();
    const command = {
      playerId,
      initialBalance: brl('0.00'),
      openedAt: at,
    };

    await new OpenWallet(
      store,
      ids(
        '0192f291-27dd-7d3f-8071-5f8685deef37',
        '0192f291-27dd-7d3f-8071-5f8685deef3a',
      ),
    ).execute(command);

    expect(
      new OpenWallet(
        store,
        ids(
          '0192f291-27dd-7d3f-8071-5f8685deef47',
          '0192f291-27dd-7d3f-8071-5f8685deef4a',
        ),
      ).execute(command),
    ).rejects.toThrow(WalletAlreadyExistsError);
    expect(store.saved).toHaveLength(1);
  });
});
