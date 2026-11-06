import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Money } from '../domain/money.js';
import {
  OpenWallet,
  WalletAlreadyExistsError,
} from '../application/open-wallet.js';
import databaseConfig from '../database/mikro-orm.config.js';
import { PostgresWalletStore } from './postgres-wallet-store.js';

const at = new Date('2026-11-05T22:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('PostgresWalletStore', () => {
  let orm: MikroORM;
  let em: EntityManager;

  beforeAll(async () => {
    orm = await MikroORM.init(databaseConfig);
    em = orm.em.fork();
  });

  afterAll(async () => {
    await orm.close();
  });

  it('stores the wallet, the opening credit and the outbox row together', async () => {
    const store = new PostgresWalletStore(em.fork());
    const wallet = await new OpenWallet(store, {
      next: () => randomUUID(),
    }).execute({
      playerId: randomUUID(),
      initialBalance: brl('1000.00'),
      openedAt: at,
    });

    const rows = await em.execute<
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
    const events = await em.execute<Array<{ total: string }>>(
      `select count(*)::text as total from outbox_messages where aggregate_id = ?`,
      [wallet.id],
      'all',
    );

    expect(rows[0].balance_amount).toBe('1000.00');
    expect(rows[0].version).toBe(1);
    expect(ledger[0].total).toBe('1');
    expect(events[0].total).toBe('1');
  });

  it('rejects the second wallet for the same player and currency', async () => {
    const playerId = randomUUID();
    const store = new PostgresWalletStore(em.fork());

    await new OpenWallet(store, { next: () => randomUUID() }).execute({
      playerId,
      initialBalance: brl('0.00'),
      openedAt: at,
    });

    expect(
      new OpenWallet(new PostgresWalletStore(em.fork()), {
        next: () => randomUUID(),
      }).execute({
        playerId,
        initialBalance: brl('0.00'),
        openedAt: at,
      }),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });
});
