import { describe, expect, it } from 'bun:test';
import { Money } from '../domain/money.js';
import {
  ReconcileWallet,
  WalletBalances,
  WalletBalanceSnapshot,
  WalletNotFoundError,
} from './reconcile-wallet.js';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';

function snapshot(
  storedAmount: string,
  calculatedAmount: string,
): WalletBalanceSnapshot {
  return {
    currency: 'BRL',
    storedAmount,
    calculatedAmount,
    checkedEntries: 1,
  };
}

class MemoryBalances implements WalletBalances {
  constructor(private readonly current?: WalletBalanceSnapshot) {}

  async read(id: string): Promise<WalletBalanceSnapshot | undefined> {
    return id === walletId ? this.current : undefined;
  }
}

describe('ReconcileWallet', () => {
  it('reports a wallet whose balance matches the ledger', async () => {
    const useCase = new ReconcileWallet(
      new MemoryBalances(snapshot('100.00', '100.00')),
    );

    const report = await useCase.execute(walletId);

    expect(report.consistent).toBe(true);
    expect(
      report.difference.equals(Money.from({ amount: '0.00', currency: 'BRL' })),
    ).toBe(true);
    expect(report.checkedEntries).toBe(1);
    expect(useCase.divergenceCount).toBe(0);
  });

  it('reports the gap and does not change the stored balance', async () => {
    const balances = new MemoryBalances(snapshot('100.00', '90.00'));
    const useCase = new ReconcileWallet(balances);

    const report = await useCase.execute(walletId);
    const again = await balances.read(walletId);

    expect(report.consistent).toBe(false);
    expect(
      report.storedBalance.equals(
        Money.from({ amount: '100.00', currency: 'BRL' }),
      ),
    ).toBe(true);
    expect(
      report.calculatedBalance.equals(
        Money.from({ amount: '90.00', currency: 'BRL' }),
      ),
    ).toBe(true);
    expect(
      report.difference.equals(
        Money.from({ amount: '10.00', currency: 'BRL' }),
      ),
    ).toBe(true);
    expect(again?.storedAmount).toBe('100.00');
    expect(useCase.divergenceCount).toBe(1);
  });

  it('rejects an unknown wallet', async () => {
    const useCase = new ReconcileWallet(new MemoryBalances());

    await expect(useCase.execute(walletId)).rejects.toThrow(
      WalletNotFoundError,
    );
  });
});
