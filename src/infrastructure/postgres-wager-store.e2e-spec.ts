import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Money } from '../domain/money.js';
import { OpenWallet } from '../application/open-wallet.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import databaseConfig from '../database/mikro-orm.config.js';
import { PostgresWalletStore } from './postgres-wallet-store.js';
import { PostgresWagerStore } from './postgres-wager-store.js';
import {
  IdempotencyConflictError,
  ProcessWager,
} from '../application/process-wager.js';

const at = new Date('2026-11-06T10:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('PostgresWagerStore', () => {
  let orm: MikroORM;
  let em: EntityManager;

  beforeAll(async () => {
    orm = await MikroORM.init(databaseConfig);
    em = orm.em.fork();
  });

  afterAll(async () => {
    await orm.close();
  });

  it('debits a bet once and replays the same key', async () => {
    const wallet = await new OpenWallet(new PostgresWalletStore(em.fork()), {
      next: () => randomUUID(),
    }).execute({
      playerId: randomUUID(),
      initialBalance: brl('100.00'),
      openedAt: at,
    });
    const command = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: `provider-a:${randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      at,
    };
    const useCase = new ProcessWager(new PostgresWagerStore(em.fork()), {
      next: () => randomUUID(),
    });

    const first = await useCase.execute(command);
    const replay = await useCase.execute(command);
    const balance = await em.execute<
      Array<{ balance_amount: string; version: number }>
    >(
      `select balance_amount::text as balance_amount, version from wallets where id = ?`,
      [wallet.id],
      'all',
    );
    const ledger = await em.execute<Array<{ total: string }>>(
      `select count(*)::text as total from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
      'all',
    );

    expect(first.idempotentReplay).toBe(false);
    expect(first.balance.equals(brl('75.00'))).toBe(true);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.equals(brl('75.00'))).toBe(true);
    expect(balance[0].balance_amount).toBe('75.00');
    expect(balance[0].version).toBe(2);
    expect(ledger[0].total).toBe('2');
  });

  it('rejects a bet that would make the balance negative without a ledger line', async () => {
    const wallet = await new OpenWallet(new PostgresWalletStore(em.fork()), {
      next: () => randomUUID(),
    }).execute({
      playerId: randomUUID(),
      initialBalance: brl('50.00'),
      openedAt: at,
    });

    const result = await new ProcessWager(new PostgresWagerStore(em.fork()), {
      next: () => randomUUID(),
    }).execute({
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: `provider-a:${randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('80.00'),
      at,
    });
    const ledger = await em.execute<Array<{ total: string }>>(
      `select count(*)::text as total from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
      'all',
    );

    expect(result.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(result.balance.equals(brl('50.00'))).toBe(true);
    expect(ledger[0].total).toBe('1');
  });

  it('lets only one of two simultaneous bets debit the same wallet', async () => {
    const wallet = await new OpenWallet(new PostgresWalletStore(em.fork()), {
      next: () => randomUUID(),
    }).execute({
      playerId: randomUUID(),
      initialBalance: brl('100.00'),
      openedAt: at,
    });

    const bet = (externalTransactionId: string) => ({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('80.00'),
      at,
    });

    // cada aposta usa um fork: as duas travam a mesma carteira ao mesmo tempo
    const [left, right] = await Promise.all([
      new ProcessWager(new PostgresWagerStore(em.fork()), {
        next: () => randomUUID(),
      }).execute(bet(randomUUID())),
      new ProcessWager(new PostgresWagerStore(em.fork()), {
        next: () => randomUUID(),
      }).execute(bet(randomUUID())),
    ]);

    const processed = [left, right].find(
      (result) => result.status === WagerTransactionStatus.Processed,
    );
    const rejected = [left, right].find(
      (result) => result.status === WagerTransactionStatus.Rejected,
    );
    const balance = await em.execute<
      Array<{ balance_amount: string; version: number }>
    >(
      `select balance_amount::text as balance_amount, version from wallets where id = ?`,
      [wallet.id],
      'all',
    );
    const ledger = await em.execute<Array<{ total: string }>>(
      `select count(*)::text as total from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
      'all',
    );
    const debits = await em.execute<Array<{ total: string }>>(
      `select count(*)::text as total
     from wallet_ledger_entries
     where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
      'all',
    );

    expect(processed?.balance.equals(brl('20.00'))).toBe(true);
    expect(processed?.idempotentReplay).toBe(false);
    expect(rejected?.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect(rejected?.balance.equals(brl('20.00'))).toBe(true);
    expect(balance[0].balance_amount).toBe('20.00');
    expect(balance[0].version).toBe(2);
    expect(ledger[0].total).toBe('2');
    expect(debits[0].total).toBe('1');
  });

  it('debits a bet once when the same command arrives 50 times', async () => {
    const wallet = await new OpenWallet(new PostgresWalletStore(em.fork()), {
      next: () => randomUUID(),
    }).execute({
      playerId: randomUUID(),
      initialBalance: brl('100.00'),
      openedAt: at,
    });
    const externalTransactionId = randomUUID();
    const command = {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      at,
    };

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        new ProcessWager(new PostgresWagerStore(em.fork()), {
          next: () => randomUUID(),
        }).execute(command),
      ),
    );
    const fulfilled = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const debits = await em.execute<Array<{ total: string }>>(
      `select count(*)::text as total
     from wallet_ledger_entries
     where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
      'all',
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(IdempotencyConflictError);
      }
    }
    expect(fulfilled.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );
    expect(
      fulfilled.every((result) => result.balance.equals(brl('75.00'))),
    ).toBe(true);
    expect(debits[0].total).toBe('1');
  });

  it('processes bets on three wallets at the same time', async () => {
    const wallets = await Promise.all(
      [brl('100.00'), brl('80.00'), brl('40.00')].map((initialBalance) =>
        new OpenWallet(new PostgresWalletStore(em.fork()), {
          next: () => randomUUID(),
        }).execute({
          playerId: randomUUID(),
          initialBalance,
          openedAt: at,
        }),
      ),
    );

    const results = await Promise.all(
      wallets.map((wallet) => {
        const externalTransactionId = randomUUID();
        return new ProcessWager(new PostgresWagerStore(em.fork()), {
          next: () => randomUUID(),
        }).execute({
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Bet,
          money: brl('15.00'),
          at,
        });
      }),
    );

    expect(results.map((result) => result.status)).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Processed,
    ]);
    expect(results[0].balance.equals(brl('85.00'))).toBe(true);
    expect(results[1].balance.equals(brl('65.00'))).toBe(true);
    expect(results[2].balance.equals(brl('25.00'))).toBe(true);
  });

  it('keeps a refund pending when the bet has not arrived', async () => {
    const wallet = await new OpenWallet(new PostgresWalletStore(em.fork()), {
      next: () => randomUUID(),
    }).execute({
      playerId: randomUUID(),
      initialBalance: brl('100.00'),
      openedAt: at,
    });
    const externalTransactionId = randomUUID();

    const result = await new ProcessWager(new PostgresWagerStore(em.fork()), {
      next: () => randomUUID(),
    }).execute({
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: randomUUID(),
      money: brl('25.00'),
      at,
    });
    const ledger = await em.execute<Array<{ total: string }>>(
      `select count(*)::text as total from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
      'all',
    );

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.balance.equals(brl('100.00'))).toBe(true);
    expect(ledger[0].total).toBe('1');
  });
});
