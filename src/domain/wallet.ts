import { InvalidMoneyError, Money } from "./money.js";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.js";

export class InsufficientBalanceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InsufficientBalanceError";
    }
}

export class InvalidWalletOperationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidWalletOperationError"
    }
}

export interface WalletState {
    id: string;
    playerId: string;
    balance: Money;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface OpenWalletProps {
    id: string;
    playerId: string;
    initialBalance: Money;
    openedAt: Date;
    opening?: {
        transactionId: string;
        ledgerEntryId: string;
    };
}

export class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private _balance: Money,
        private _version: number,
        public readonly createdAt: Date,
        private _updatedAt: Date,
    ) {}

    static open(props: OpenWalletProps): { wallet: Wallet; entry?: WalletLedgerEntry} {
        assertNotBlank(props.id, 'wallet id');
        assertNotBlank(props.playerId, 'player id');

        const wallet = new Wallet(
            props.id,
            props.playerId,
            props.initialBalance.currency,
            props.initialBalance,
            1,
            props.openedAt,
            props.openedAt
        );

        if (props.initialBalance.isZero()) {
            if (props.opening) {
                throw new InvalidWalletOperationError("zero opening balance does not produce a ledger entry");
            }

            return { wallet }
        }

        if (!props.initialBalance.isPositive()) {
            throw new InvalidWalletOperationError("opening balance requires a ledger entry");
        }

        if (!props.opening) {
            throw new InvalidWalletOperationError("positive opening balance requires a ledger entry");
        }

        const entry = WalletLedgerEntry.create({
            id: props.opening.ledgerEntryId,
            walletId: wallet.id,
            transactionId: props.opening.transactionId,
            direction: LedgerDirection.Credit,
            money: props.initialBalance,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: props.initialBalance,
            createdAt: props.openedAt,
        });

        return { wallet, entry}
    }

    static rehydrate(state: WalletState): Wallet {
        return new Wallet(
            state.id,
            state.playerId,
            state.balance.currency,
            state.balance,
            state.version,
            state.createdAt,
            state.updatedAt,
        );
    }

    get balance(): Money {
        return this._balance;
    }

    get version(): number {
        return this._version;
    }

    get updatedAt(): Date {
        return this._updatedAt;
    }

    debit(money: Money, transactionId: string, ledgerEntryId: string, at: Date): WalletLedgerEntry {
        return this.move(LedgerDirection.Debit, money, transactionId, ledgerEntryId, at)
    }

    credit(money: Money, transactionId: string, ledgerEntryId: string, at: Date): WalletLedgerEntry {
        return this.move(LedgerDirection.Credit, money, transactionId, ledgerEntryId, at)
    }

    private move(
        direction: LedgerDirection,
        money: Money,
        transactionId: string,
        ledgerEntryId: string,
        at: Date,
    ): WalletLedgerEntry {
        this.assertSameCurrency(money);
        assertNotBlank(transactionId, 'transaction id');
        assertNotBlank(ledgerEntryId, 'ledger entry id');

        if (!money.isPositive()){
            throw new InvalidWalletOperationError("movement amount must be positive");
        }

        const balanceBefore = this._balance;
        const balanceAfter = direction === LedgerDirection.Credit ? balanceBefore.add(money) : 
            balanceBefore.subtract(money);

        if (balanceAfter.isNegative()){
            throw new InsufficientBalanceError("balance cannot go negative");
        }

        this._balance = balanceAfter;
        this._version += 1;
        this._updatedAt = at;

        return WalletLedgerEntry.create({
            id: ledgerEntryId,
            walletId: this.id,
            transactionId,
            direction,
            money,
            balanceBefore,
            balanceAfter,
            createdAt: at,
        })
    }

    private assertSameCurrency(money: Money): void {
        if (money.currency !== this.currency) {
            throw new InvalidMoneyError(`currency mismatch: ${this.currency} and ${money.currency}`)
        }
    }
}

function assertNotBlank(value: string, label: string): void {
    if (value.trim().length === 0){
        throw new InvalidWalletOperationError(`${label} is required`)
    }
}

