/**
 * Money as integer minor units (e.g. US cents). Never use floating point for
 * financial values (pack §8, BR-005/006). All arithmetic is exact.
 *
 * `currency` is an ISO-4217 code; base currency is USD (FIN-013, NFR-020).
 */
export type Money = {
  /** Integer minor units. 1234 with currency "USD" == $12.34. */
  readonly minor: number;
  readonly currency: string;
};

export class MoneyError extends Error {}

function assertInteger(minor: number): void {
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError(`money minor units must be a safe integer, got ${minor}`);
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function money(minor: number, currency = 'USD'): Money {
  assertInteger(minor);
  return { minor, currency };
}

export const zero = (currency = 'USD'): Money => money(0, currency);

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.minor, a.currency);
}

export function isZero(a: Money): boolean {
  return a.minor === 0;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0;
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.minor === b.minor ? 0 : a.minor < b.minor ? -1 : 1;
}

export function sum(items: readonly Money[], currency = 'USD'): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

/** Format for display only; never parse this back into a transaction. */
export function format(a: Money): string {
  const sign = a.minor < 0 ? '-' : '';
  const abs = Math.abs(a.minor);
  const major = Math.trunc(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  return `${sign}${a.currency} ${major}.${minor}`;
}
