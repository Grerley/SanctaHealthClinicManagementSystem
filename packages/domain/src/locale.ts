/**
 * Localisation conventions (NFR-020, pack §1). The system uses British English,
 * DD/MM/YYYY dates and USD as the base currency. These helpers centralise the
 * conventions so presentation is consistent everywhere.
 */
import { type Money, format as formatMoney } from './money.ts';

export const BASE_CURRENCY = 'USD';
export const LOCALE = 'en-GB';

/** Format an ISO date (YYYY-MM-DD) as DD/MM/YYYY. Throws on a malformed input. */
export function formatDateDDMMYYYY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`expected an ISO date, got "${iso}"`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Money formatted in the base currency convention (e.g. "USD 12.50"). */
export function formatCurrency(m: Money): string {
  return formatMoney(m);
}
