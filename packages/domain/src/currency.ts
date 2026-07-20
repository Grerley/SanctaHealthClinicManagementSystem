/**
 * Multi-currency conversion to the base currency (FIN-013, pack §10.3). The base
 * currency is USD (NFR-020); a transaction may be captured in another currency
 * with an exchange rate, and BOTH the original and the base-currency amount are
 * retained. Rates are expressed in basis points (10000 = 1.0000) so conversion
 * stays in exact integer minor units — no floating-point drift.
 */
import { type Money, money } from './money.ts';
import { BASE_CURRENCY } from './locale.ts';

export class CurrencyError extends Error {}

export type ConvertedAmount = {
  original: Money;      // as captured, in the transaction currency
  rateBps: number;      // base units per 1 transaction unit × 10000
  base: Money;          // converted to the base currency (USD)
};

/**
 * Convert a transaction amount to the base currency. `rateBps` is the base-per-
 * transaction rate in basis points (e.g. 1 EUR = 1.08 USD → 10800). A base-currency
 * amount converts 1:1 regardless of rate.
 */
export function toBaseCurrency(amountMinor: number, currency: string, rateBps: number): ConvertedAmount {
  if (!Number.isInteger(amountMinor)) throw new CurrencyError('amount must be an integer minor unit');
  if (currency === BASE_CURRENCY) {
    return { original: money(amountMinor, currency), rateBps: 10000, base: money(amountMinor, BASE_CURRENCY) };
  }
  if (!Number.isInteger(rateBps) || rateBps <= 0) throw new CurrencyError('rateBps must be a positive integer');
  const baseMinor = Math.round((amountMinor * rateBps) / 10000);
  return { original: money(amountMinor, currency), rateBps, base: money(baseMinor, BASE_CURRENCY) };
}
