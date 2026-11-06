import { createHash } from 'node:crypto';
import { Money } from '../domain/money.js';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
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
  WagerTransactionPendingReference,
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
  referenceExternalTransactionId?: string;
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
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findActiveReversal(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<boolean>;
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
  ) {}

  async execute(command: ProcessWagerCommand): Promise<WagerResult> {
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
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: command.at,
      });

      const reference = command.referenceExternalTransactionId
        ? await tx.findByExternalId(
            command.providerId,
            command.referenceExternalTransactionId,
          )
        : undefined;

      if (transaction.requiresReference() && !reference) {
        transaction.markPendingReference();
        await tx.save({
          transaction,
          wallet,
          events: [
            new WagerTransactionPendingReference({
              eventId: this.ids.next(),
              aggregateId: wallet.id,
              correlationId: transaction.id,
              occurredAt: command.at,
              data: {
                transactionId: transaction.id,
                walletId: wallet.id,
                referenceExternalTransactionId:
                  command.referenceExternalTransactionId ?? '',
              },
            }),
          ],
        });

        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance: wallet.balance,
          idempotentReplay: false,
        };
      }

      if (
        transaction.requiresReference() &&
        (await tx.findActiveReversal(
          command.providerId,
          command.referenceExternalTransactionId ?? '',
        ))
      ) {
        return this.reject(
          tx,
          transaction,
          wallet,
          'REFERENCE_ALREADY_REVERSED',
          command,
        );
      }

      if (reference) {
        try {
          transaction.assertCompatibleReference(reference);
        } catch (error) {
          // referência que não serve vira rejeição gravada; outro erro desfaz a transação
          if (error instanceof InvalidTransactionStateError) {
            return this.reject(
              tx,
              transaction,
              wallet,
              'INVALID_REFERENCE',
              command,
            );
          }
          throw error;
        }
      }

      if (transaction.kind === WagerTransactionKind.Loss) {
        transaction.markProcessed({
          resultBalance: wallet.balance,
          at: command.at,
        });
        await tx.save({
          transaction,
          wallet,
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
          ],
        });

        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance: wallet.balance,
          idempotentReplay: false,
        };
      }

      const direction = transaction.ledgerDirectionFor(reference);
      if (
        direction === LedgerDirection.Debit &&
        wallet.balance.isLessThan(command.money)
      ) {
        // win e refund creditam; só o débito pode deixar o saldo negativo
        return this.reject(
          tx,
          transaction,
          wallet,
          transaction.kind === WagerTransactionKind.Bet
            ? 'INSUFFICIENT_BALANCE'
            : 'REVERSAL_WOULD_GO_NEGATIVE',
          command,
        );
      }

      const entry =
        direction === LedgerDirection.Debit
          ? wallet.debit(
              command.money,
              transaction.id,
              this.ids.next(),
              command.at,
            )
          : wallet.credit(
              command.money,
              transaction.id,
              this.ids.next(),
              command.at,
            );
      transaction.markProcessed({
        referenceTransactionId: reference?.id,
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

  private async reject(
    tx: WagerTx,
    transaction: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    command: ProcessWagerCommand,
  ): Promise<WagerResult> {
    transaction.reject(code, command.at);
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
          failureCode: code,
        }),
      ],
    });

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance,
      idempotentReplay: false,
      failureCode: code,
    };
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
    // vazio na aposta: dois refunds de apostas diferentes não podem ter o mesmo hash
    referenceExternalTransactionId:
      command.referenceExternalTransactionId ?? '',
    roundId: command.roundId,
    walletId: command.walletId,
  });

  return createHash('sha256').update(canonical).digest('hex');
}
