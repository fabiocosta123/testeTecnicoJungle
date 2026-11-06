import { createHash } from 'node:crypto';
import { Money } from '../domain/money.js';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import {
    FailureCode,
    InvalidTransactionStateError,
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import {
    IntegrationEvent,
    WalletBalanceChanged,
    WagerTransactionProcessed,
    WagerTransactionRejected,
} from '../domain/integration-event.js';
import { IdSource } from './open-wallet.js';
import { Wallet } from '../domain/wallet.js';


export class IdempotencyConflictError extends Error {
    constructor() {
        super('idempotency key was reused with a different payload');
        this.name = 'IdempotencyConflictError';
    }
}

export class WagerNotFoundError extends Error {
    constructor() {
        super('wallet was not found');
        this.name = 'WalletNotFound';
    }
}

export interface ProcessWagerCommand {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    at: Date;
}

export interface WagerResult {
    transactionId: string;
    status: WagerTransactionStatus;
    balance: Money;
    idempotentReplay: boolean;
    failureCode?: FailureCode;
}

export interface SavedWager {
    transaction: WagerTransaction;
    wallet: Wallet;
    entry?: WalletLedgerEntry;
    events: IntegrationEvent<unknown>[];
}

export interface WagerTx {
    findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
    lockWallet(walletId: string): Promise<Wallet | undefined>;
    save(saved: SavedWager): Promise<void>;
}

export interface WagerStore {
    transact<T>(walletId: string, work: (tx: WagerTx) => Promise<T>): Promise<T>;
}

export class ProcessWager {
    constructor(
        private readonly store: WagerStore,
        private readonly ids: IdSource,
    ) { }

    async execute(command: ProcessWagerCommand): Promise<WagerResult> {
        if (command.kind !== WagerTransactionKind.Bet) {
            throw new InvalidTransactionStateError('only a bet is processed');
        }

        const payloadHash = hashWager(command);

        return this.store.transact(command.walletId, async (tx) => {
            const wallet = await tx.lockWallet(command.walletId);
            if (!wallet) {
                throw new WagerNotFoundError();
            }

            if (
                wallet.playerId !== command.playerId ||
                wallet.currency !== command.money.currency
            ) {
                throw new InvalidTransactionStateError(
                    'wallet does not match the wager',
                );
            }

            const existing = await tx.findByIdempotencyKey(command.idempotencyKey);
            if (existing) {
                if (!existing.matchesPayload(payloadHash)) {
                    throw new IdempotencyConflictError();
                }

                return {
                    transactionId: existing.id,
                    status: existing.status,
                    balance: existing.resultBalance ?? wallet.balance,
                    idempotentReplay: true,
                    failureCode: existing.failureCode,
                };
            }

            const transaction = WagerTransaction.create({
                id: this.ids.next(),
                providerId: command.providerId,
                externalTransactionId: command.externalTransactionId,
                idempotencyKey: command.idempotencyKey,
                payloadHash,
                walletId: command.walletId,
                playerId: command.playerId,
                roundId: command.roundId,
                gameId: command.gameId,
                kind: command.kind,
                money: command.money,
                createdAt: command.at,
            });

            if (wallet.balance.isLessThan(command.money)) {
                transaction.reject('INSUFFICIENT_BALANCE', command.at);
                await tx.save({
                    transaction,
                    wallet,
                    events: [
                        WagerTransactionRejected.create({
                            eventId: this.ids.next(),
                            walletId: wallet.id,
                            correlationId: transaction.id,
                            occurredAt: command.at,
                            transactionId: transaction.id,
                            playerId: command.playerId,
                            kind: transaction.kind,
                            failureCode: 'INSUFFICIENT_BALANCE',
                        }),
                    ],
                });

                return {
                    transactionId: transaction.id,
                    status: transaction.status,
                    balance: wallet.balance,
                    idempotentReplay: false,
                    failureCode: transaction.failureCode,
                };
            }

            const entry = wallet.debit(
                command.money,
                transaction.id,
                this.ids.next(),
                command.at,
            );
            transaction.markProcessed({
                resultBalance: wallet.balance,
                at: command.at,
            });

            await tx.save({
                transaction,
                wallet,
                entry,
                events: [
                    WagerTransactionProcessed.create({
                        eventId: this.ids.next(),
                        walletId: wallet.id,
                        correlationId: transaction.id,
                        occurredAt: command.at,
                        transactionId: transaction.id,
                        playerId: command.playerId,
                        kind: transaction.kind,
                        money: command.money.toJSON(),
                    }),
                    WalletBalanceChanged.from(wallet, entry, {
                        eventId: this.ids.next(),
                        correlationId: transaction.id,
                        occurredAt: command.at,
                    }),
                ],
            });

            return {
                transactionId: transaction.id,
                status: transaction.status,
                balance: wallet.balance,
                idempotentReplay: false,
            };
        });
    }
}

function hashWager(command: ProcessWagerCommand): string {
    const money = command.money.toJSON();
    const canonical = JSON.stringify({
        amount: money.amount,
        currency: money.currency,
        externalTransactionId: command.externalTransactionId,
        gameId: command.gameId,
        kind: command.kind,
        playerId: command.playerId,
        providerId: command.providerId,
        roundId: command.roundId,
        walletId: command.walletId,
    });

    return createHash('sha256').update(canonical).digest('hex');
}
