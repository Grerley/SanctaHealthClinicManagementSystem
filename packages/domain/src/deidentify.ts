/**
 * De-identification projections (VIS-009, MGT-009, pack §4.4/§9.3). Public-facing
 * and analytical views must never carry direct identifiers (name, MRN, exact date
 * of birth, phone). These pure projections DROP identifiers and generalise the
 * date of birth to an age band, so a screen in a waiting room or an analytical
 * dataset cannot re-identify a patient. The pseudonymous id is supplied by the
 * caller (hashed at the edge) — the domain never sees the real identifier.
 */

/** Coarse age band from a date of birth — never the exact DOB (MGT-009). */
export function ageBand(dobIso: string, asOfIso: string): string {
  const dob = new Date(dobIso + 'T00:00:00Z');
  const asOf = new Date(asOfIso + 'T00:00:00Z');
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const m = asOf.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && asOf.getUTCDate() < dob.getUTCDate())) age--;
  if (age < 0) return 'unknown';
  if (age < 5) return '0-4';
  if (age < 15) return '5-14';
  if (age < 25) return '15-24';
  if (age < 35) return '25-34';
  if (age < 45) return '35-44';
  if (age < 55) return '45-54';
  if (age < 65) return '55-64';
  return '65+';
}

export type PublicQueueEntry = { token: string; station: string | null; status: string; waitMinutes: number | null };

/**
 * Project a queue row to a de-identified public-screen entry (VIS-009). Only the
 * queue token, station, status and wait are exposed — never any patient identity.
 */
export function publicQueueEntry(row: { token: string; station?: string | null; status: string; waitMinutes?: number | null }): PublicQueueEntry {
  return {
    token: row.token,
    station: row.station ?? null,
    status: row.status,
    waitMinutes: row.waitMinutes ?? null,
  };
}

export type AnalyticalRecord = { pseudoId: string; ageBand: string; sex: string; siteId: string | null };

/**
 * Project a patient to a de-identified analytical record (MGT-009). Carries a
 * pseudonymous id (hashed upstream), age band, sex and site — no name, MRN, exact
 * DOB or contact detail. This is the ONLY shape allowed to leave the live path
 * for analytics.
 */
export function analyticalRecord(args: { pseudoId: string; dob: string; sex: string | null; siteId: string | null; asOf: string }): AnalyticalRecord {
  return {
    pseudoId: args.pseudoId,
    ageBand: ageBand(args.dob, args.asOf),
    sex: args.sex ?? 'unknown',
    siteId: args.siteId ?? null,
  };
}
