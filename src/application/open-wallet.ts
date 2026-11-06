import { createHash } from 'node:crypto';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import {
  IntegrationEvent,
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from '../domain/integration-event.js';

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
  openedAt: Date;
}

export interface IdSource {
  next(): string;
}

export interface WalletOpened {
  wallet: Wallet;
  opening?: WagerTransaction;
  entry?: WalletLedgerEntry;
  events: IntegrationEvent<unknown>[];
}

export interface WalletStore {
  saveOpening(opened: WalletOpened): Promise<void>;
}

export class OpenWallet {
  constructor(
    private readonly store: WalletStore,
    private readonly ids: IdSource,
  ) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const walletId = this.ids.next();
    const opening = command.initialBalance.isPositive()
      ? this.openTransaction(walletId, command)
      : undefined;

    const opened = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openedAt: command.openedAt,
      opening: opening
        ? {
            transactionId: opening.transaction.id,
            ledgerEntryId: opening.ledgerEntryId,
          }
        : undefined,
    });

    //const balance = opened.wallet.balance.toJSON();

    await this.store.saveOpening({
      wallet: opened.wallet,
      opening: opening?.transaction,
      entry: opened.entry,
      events:
        opening && opened.entry
          ? [
              WagerTransactionProcessed.create({
                eventId: this.ids.next(),
                walletId,
                correlationId: opening.transaction.id,
                occurredAt: command.openedAt,
                transactionId: opening.transaction.id,
                playerId: command.playerId,
                kind: opening.transaction.kind,
                money: opening.transaction.money.toJSON(),
              }),
              WalletBalanceChanged.from(opened.wallet, opened.entry, {
                eventId: this.ids.next(),
                correlationId: opening.transaction.id,
                occurredAt: command.openedAt,
              }),
            ]
          : [],
    });

    return opened.wallet;
  }

  private openTransaction(walletId: string, command: OpenWalletCommand) {
    const transactionId = this.ids.next();
    const ledgerEntryId = this.ids.next();
    const transaction = WagerTransaction.opening({
      id: transactionId,
      walletId,
      playerId: command.playerId,
      externalTransactionId: `opening:${walletId}`,
      idempotencyKey: `internal:opening:${walletId}`,
      payloadHash: hashOpening({
        playerId: command.playerId,
        walletId,
        amount: command.initialBalance.toJSON().amount,
        currency: command.initialBalance.currency,
      }),
      money: command.initialBalance,
      createdAt: command.openedAt,
    });

    return { transaction, ledgerEntryId };
  }
}

function hashOpening(input: {
  playerId: string;
  walletId: string;
  amount: string;
  currency: string;
}): string {
  // chavem em ordem alfabética: o hash tem que ser o mesmo em qualquer maquina
  const canonical = JSON.stringify({
    amount: input.amount,
    currency: input.currency,
    gameId: 'opening',
    kind: 'OPENING',
    playerId: input.playerId,
    providerId: 'internal',
    roundId: 'opening',
    walletId: input.walletId,
  });

  return createHash('sha256').update(canonical).digest('hex');
}
