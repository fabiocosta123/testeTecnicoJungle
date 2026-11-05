import { describe, expect, it } from 'bun:test';
import { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';
import {
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

const at = new Date('2026-11-05T12:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function bet(): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-bet',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash-bet',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: at,
  });
}

describe('WagerTransaction', () => {
  it('starts a bet as pending', () => {
    const transaction = bet();

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  it('rejects an opening submitted by a provider', () => {
    expect(() =>
      WagerTransaction.create({
        id: 'tx-open',
        providerId: 'provider-a',
        externalTransactionId: 'open-1',
        idempotencyKey: 'provider-a:open-1',
        payloadHash: 'hash-open',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Opening,
        money: brl('10.00'),
        createdAt: at,
      }),
    ).toThrow(InvalidTransactionStateError);
  });

  it('rejects a refund without a reference', () => {
    expect(() =>
      WagerTransaction.create({
        id: 'tx-refund',
        providerId: 'provider-a',
        externalTransactionId: 'refund-1',
        idempotencyKey: 'provider-a:refund-1',
        payloadHash: 'hash-refund',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: brl('25.00'),
        createdAt: at,
      }),
    ).toThrow(InvalidTransactionStateError);
  });

  it('stores the balance seen when the bet is processed', () => {
    const transaction = bet();

    transaction.markProcessed({
      resultBalance: brl('75.00'),
      at,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.resultBalance?.equals(brl('75.00'))).toBe(true);
    expect(() =>
      transaction.markProcessed({ resultBalance: brl('75.00'), at }),
    ).toThrow(InvalidTransactionStateError);
  });

  it('does not move the balance on a loss', () => {
    const loss = WagerTransaction.create({
      id: 'tx-loss',
      providerId: 'provider-a',
      externalTransactionId: 'loss-1',
      idempotencyKey: 'provider-a:loss-1',
      payloadHash: 'hash-loss',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Loss,
      money: brl('25.00'),
      createdAt: at,
    });

    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  it('credits a refund and debits a rollback of a win', () => {
    const win = WagerTransaction.create({
      id: 'tx-win',
      providerId: 'provider-a',
      externalTransactionId: 'win-1',
      idempotencyKey: 'provider-a:win-1',
      payloadHash: 'hash-win',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: brl('40.00'),
      createdAt: at,
    });
    win.markProcessed({ resultBalance: brl('115.00'), at });

    const refund = WagerTransaction.create({
      id: 'tx-refund',
      providerId: 'provider-a',
      externalTransactionId: 'refund-1',
      idempotencyKey: 'provider-a:refund-1',
      payloadHash: 'hash-refund',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'transaction-123',
      createdAt: at,
    });
    const rollback = WagerTransaction.create({
      id: 'tx-rollback',
      providerId: 'provider-a',
      externalTransactionId: 'rollback-1',
      idempotencyKey: 'provider-a:rollback-1',
      payloadHash: 'hash-rollback',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: brl('40.00'),
      referenceExternalTransactionId: 'win-1',
      createdAt: at,
    });

    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('matches the same payload and rejects a different one', () => {
    const transaction = bet();

    expect(transaction.matchesPayload('hash-bet')).toBe(true);
    expect(transaction.matchesPayload('other-hash')).toBe(false);
  });
});