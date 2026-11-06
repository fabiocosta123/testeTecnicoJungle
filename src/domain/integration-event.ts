import { MoneyProps } from "./money.js";
import { Wallet } from './wallet.js';
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.js";

export interface EventContext {
    eventId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
}

export interface IntegrationEventProps<T> {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: T;
}

export abstract class IntegrationEvent<T> {
    abstract readonly eventType: string;
    abstract readonly version: number;

    readonly eventId: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly occurredAt: Date;
    readonly data: Readonly<T>;

    protected constructor(props: IntegrationEventProps<T>) {
        this.eventId = props.eventId;
        this.aggregateId = props.aggregateId;
        this.correlationId = props.correlationId;
        this.causationId = props.causationId;
        this.occurredAt = props.occurredAt;
        this.data = props.data;
    }

    toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  kind: string;
  money: MoneyProps;
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static create(input: {
    eventId: string;
    walletId: string;
    correlationId: string;
    occurredAt: Date;
    transactionId: string;
    playerId: string;
    kind: string;
    money: MoneyProps;
  }): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: input.eventId,
      aggregateId: input.walletId,
      correlationId: input.correlationId,
      occurredAt: input.occurredAt,
      data: {
        transactionId: input.transactionId,
        walletId: input.walletId,
        playerId: input.playerId,
        kind: input.kind,
        money: input.money,
      },
    });
  }
}
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }

}

