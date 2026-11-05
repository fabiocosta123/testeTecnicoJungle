import { describe, expect, it } from 'bun:test';
import { InvalidMoneyError, Money } from './money.js';

describe('Money', () => {
  it('serializes with two decimal places', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });

    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(money.toString()).toBe('25.00 BRL');
  });

  it('keeps cent addition exact', () => {
    const sum = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );

    expect(sum.toJSON().amount).toBe('0.30');
  });

  it('does not change the original value', () => {
    const original = Money.from({ amount: '10.00', currency: 'BRL' });

    original.add(Money.from({ amount: '1.00', currency: 'BRL' }));

    expect(original.toJSON().amount).toBe('10.00');
  });

  it('rejects amounts that are not exactly two non-negative decimal places', () => {
    const rejected = [
      '',
      '1',
      '1.1',
      '1.001',
      '01.00',
      '-1.00',
      '1e2',
      'NaN',
      'Infinity',
      ' 1.00',
      '1.00 ',
    ];

    for (const amount of rejected) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects a currency that is not three uppercase letters', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.zero('')).toThrow(InvalidMoneyError);
  });

  it('treats zero as neither positive nor negative', () => {
    const zero = Money.zero('BRL');

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(zero.negate().isZero()).toBe(true);
    expect(zero.equals(Money.from({ amount: '0.00', currency: 'BRL' }))).toBe(
      true,
    );
  });

  it('subtracts and can represent a negative result', () => {
    const result = Money.from({ amount: '20.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '80.00', currency: 'BRL' }),
    );

    expect(result.toJSON().amount).toBe('-60.00');
    expect(result.isNegative()).toBe(true);
    expect(result.isLessThan(Money.zero('BRL'))).toBe(true);
  });

  it('refuses to mix currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(InvalidMoneyError);
    expect(() => brl.subtract(usd)).toThrow(InvalidMoneyError);
    expect(() => brl.isLessThan(usd)).toThrow(InvalidMoneyError);
    expect(brl.equals(usd)).toBe(false);
  });
});
