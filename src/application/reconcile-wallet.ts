import { Money } from '../domain/money.js';

export class WalletNotFoundError extends Error {
  constructor() {
    super('wallet was not found');
    this.name = 'WalletnotFoundError';
  }
}

export interface WalletBalanceSnapshot {
  currency: string;
  storedAmount: string;
  calculatedAmount: string;
  checkedEntries: number;
}

export interface WalletBalances {
  read(walletId: string): Promise<WalletBalanceSnapshot | undefined>;
}

export interface Reconciliation {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  divergenceCount = 0;

  constructor(private readonly balances: WalletBalances) {}

  async execute(walletId: string): Promise<Reconciliation> {
    const snapshot = await this.balances.read(walletId);
    if (!snapshot) {
      throw new WalletNotFoundError();
    }

    const storedBalance = Money.from({
      amount: snapshot.storedAmount,
      currency: snapshot.currency,
    });
    const calculatedBalance = Money.from({
      amount: snapshot.calculatedAmount,
      currency: snapshot.currency,
    });
    const difference = storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();

    // a diferença só aparece na resposta, o saldo gravado não é corrigido
    if (!consistent) {
      this.divergenceCount += 1;
      console.log(
        JSON.stringify({
          level: 'error',
          message: 'wallet balance diverges from the ledger',
          walletId,
          checkedEntries: snapshot.checkedEntries,
          difference: difference.toJSON(),
        }),
      );
    }

    return {
      walletId,
      storedBalance,
      calculatedBalance,
      difference,
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
