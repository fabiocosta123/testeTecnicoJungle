import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import {
  WalletBalances,
  WalletBalanceSnapshot,
} from '../application/reconcile-wallet.js';

@Injectable()
export class PostgresWalletReconciliation implements WalletBalances {
  constructor(private readonly em: EntityManager) {}

  async read(walletId: string): Promise<WalletBalanceSnapshot | undefined> {
    const wallets = await this.em.execute<
      Array<{ currency: string; balance_amount: string }>
    >(
      `select currency, balance_amount::text as balance_amount
       from wallets
       where id = ?`,
      [walletId],
      'all',
    );
    const wallet = wallets[0];
    if (!wallet) {
      return undefined;
    }
    const sums = await this.em.execute<
      Array<{ amount: string; total: string }>
    >(
      `select coalesce(
           sum(case when direction = 'CREDIT' then amount else -amount end),
           0
         )::numeric(18, 2)::text as amount,
         count(*)::text as total
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
      'all',
    );

    return {
      currency: wallet.currency,
      storedAmount: wallet.balance_amount,
      calculatedAmount: sums[0].amount,
      checkedEntries: Number(sums[0].total),
    };
  }
}
