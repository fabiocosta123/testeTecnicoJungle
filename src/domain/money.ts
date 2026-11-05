import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_WITH_TWO_DECIMALS = /^(0|[1-9]\d*)\.\d{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!ISO_CURRENCY.test(props.currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter ISO code');
    }

    if (!AMOUNT_WITH_TWO_DECIMALS.test(props.amount)) {
      throw new InvalidMoneyError('amount must be a non-negative decimal with 2 places');
    }

    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan('0');
  }

  isNegative(): boolean {
    return this.value.lessThan('0');
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    const props = this.toJSON();
    return `${props.amount} ${props.currency}`;
  }

  private static of(value: Decimal, currency: string): Money {
    const scaled = value.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
    const normalized = scaled.isZero() ? new Decimal('0') : scaled;
    return new Money(normalized, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new InvalidMoneyError(`currency mismatch: ${this.currency} and ${other.currency}`);
    }
  }
}
