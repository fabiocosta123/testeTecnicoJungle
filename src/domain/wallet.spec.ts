import { describe, expect, it } from 'bun:test';
import { InvalidMoneyError, Money } from './money.js';
import {
  InsufficientBalanceError,
  InvalidWalletOperationError,
  Wallet,
} from './wallet.js';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

const openedAt = new Date('2026-11-04T21:00:00.000Z');
const later = new Date('2026-11-04T21:05:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('Wallet', () => {
  it('opens a zero balance without a ledger entry', () => {
    const { wallet, entry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('0.00'),
      openedAt,
    });

    expect(entry).toBeUndefined();
    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
  });

  it('opens a positive balance at version 1 with one credit line', () => {
    const { wallet, entry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      openedAt,
      opening: { transactionId: 'opening-tx', ledgerEntryId: 'opening-entry' },
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.equals(brl('0.00'))).toBe(true);
    expect(entry?.balanceAfter.equals(brl('1000.00'))).toBe(true);
    expect(entry?.isBalanced()).toBe(true);
  });

  it('rejects a positive opening without a ledger entry', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('10.00'),
        openedAt,
      }),
    ).toThrow(InvalidWalletOperationError);
  });

  it('debits and increments the version', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openedAt,
      opening: { transactionId: 'opening-tx', ledgerEntryId: 'opening-entry' },
    });

    const entry = wallet.debit(brl('25.00'), 'bet-1', 'entry-1', later);

    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(later);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('75.00'))).toBe(true);
  });

  it('keeps the previous balance when the debit does not fit', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('20.00'),
      openedAt,
      opening: { transactionId: 'opening-tx', ledgerEntryId: 'opening-entry' },
    });

    expect(() => wallet.debit(brl('80.00'), 'bet-1', 'entry-1', later)).toThrow(
      InsufficientBalanceError,
    );
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  it('rejects a movement in another currency', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('10.00'),
      openedAt,
      opening: { transactionId: 'opening-tx', ledgerEntryId: 'opening-entry' },
    });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => wallet.credit(usd, 'win-1', 'entry-1', later)).toThrow(
      InvalidMoneyError,
    );
  });

  it('rejects a ledger line whose arithmetic does not close', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
        createdAt: later,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
