import { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export type FailureCode =
  | 'INSUFFICIENT_BALANCE'
  | 'REVERSAL_WOULD_GO_NEGATIVE'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'INVALID_REFERENCE'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH';

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionStateError('opening is internal');
    }

    assertNotBlank(props.id, 'transaction id');
    assertNotBlank(props.providerId, 'provider id');
    assertNotBlank(props.externalTransactionId, 'external transaction id');
    assertNotBlank(props.idempotencyKey, 'idempotency key');
    assertNotBlank(props.payloadHash, 'payload hash');
    assertNotBlank(props.walletId, 'wallet id');
    assertNotBlank(props.playerId, 'player id');
    assertNotBlank(props.roundId, 'round id');
    assertNotBlank(props.gameId, 'game id');

    if (props.providerId === 'internal') {
      throw new InvalidTransactionStateError('provider cannot be internal');
    }

    if (!props.money.isPositive()) {
      throw new InvalidTransactionStateError('amount must be positive');
    }

    const needsReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (needsReference && !props.referenceExternalTransactionId?.trim()) {
      throw new InvalidTransactionStateError('reversal requires a reference');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    money: Money;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionStateError('opening amount must be positive');
    }

    return new WagerTransaction(
      props.id,
      'internal',
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      'opening',
      'opening',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.createdAt,
      props.money,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
    );
  }
  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  markProcessed(input: {
    referenceTransactionId?: string;
    resultBalance: Money;
    at: Date;
  }): void {
    this.assertOpen();
    if (this.requiresReference() && !input.referenceTransactionId?.trim()) {
      throw new InvalidTransactionStateError(
        'processed reversal requires the reference id',
      );
    }
    if (input.resultBalance.currency !== this.money.currency) {
      throw new InvalidTransactionStateError(
        'result balance currency mismatch',
      );
    }

    // saldo negativo entra depois da conferência da moeda e antes de mudar status
    if (input.resultBalance.isNegative()) {
      throw new InvalidTransactionStateError(
        'result balance cannot be negative',
      );
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = input.referenceTransactionId;
    this._resultBalance = input.resultBalance;
    this._processedAt = input.at;
  }
  markPendingReference(): void {
    this.assertOpen();
    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(
        'only a reversal waits for a reference',
      );
    }
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError('transaction is already waiting');
    }
    this._status = WagerTransactionStatus.PendingReference;
  }
  reject(code: FailureCode, at: Date): void {
    this.assertOpen();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
  }
  fail(code: FailureCode, at: Date): void {
    this.assertOpen();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }
  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }
  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  assertCompatibleReference(reference: WagerTransaction): void {
    // refund e rollback só revertem a transação original, já processada
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidTransactionStateError('reference is not processed');
    }

    if (
      this.kind === WagerTransactionKind.Refund &&
      reference.kind !== WagerTransactionKind.Bet
    ) {
      throw new InvalidTransactionStateError('refund can only reverse a bet');
    }

    const rollbackCanReverse =
      reference.kind === WagerTransactionKind.Bet ||
      reference.kind === WagerTransactionKind.Win ||
      reference.kind === WagerTransactionKind.Refund;

    if (this.kind === WagerTransactionKind.Rollback && !rollbackCanReverse) {
      throw new InvalidTransactionStateError(
        'rollback cannot reverse this kind',
      );
    }

    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency ||
      !reference.money.equals(this.money)
    ) {
      throw new InvalidTransactionStateError(
        'reference does not match the reversal',
      );
    }
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Bet) {
      return LedgerDirection.Debit;
    }
    if (
      this.kind === WagerTransactionKind.Win ||
      this.kind === WagerTransactionKind.Opening ||
      this.kind === WagerTransactionKind.Refund
    ) {
      return LedgerDirection.Credit;
    }
    if (this.kind === WagerTransactionKind.Loss) {
      throw new InvalidTransactionStateError('loss does not move the balance');
    }
    if (!reference) {
      throw new InvalidTransactionStateError(
        'rollback requires the reference transaction',
      );
    }
    const referenceDirection = reference.ledgerDirectionFor();
    return referenceDirection === LedgerDirection.Debit
      ? LedgerDirection.Credit
      : LedgerDirection.Debit;
  }
  private assertOpen(): void {
    if (this.isTerminal() || this.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionStateError('transaction is terminal');
    }
  }
}
function assertNotBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new InvalidTransactionStateError(`${label} is required`);
  }
}
