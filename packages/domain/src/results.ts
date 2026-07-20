/**
 * Result classification for orders/results (ORD-005/006). Given a value and its
 * reference (and optional critical) bounds, classify normal/low/high and whether
 * the result is CRITICAL — critical results require acknowledgement and timed
 * escalation (ORD-006, UAT-06). This assists the clinician; it never decides.
 */

export type Abnormal = 'normal' | 'low' | 'high';

export type ResultClassification = {
  abnormal: Abnormal;
  critical: boolean;
};

export class ResultError extends Error {}

export type ResultBounds = {
  refLow?: number | undefined;
  refHigh?: number | undefined;
  criticalLow?: number | undefined;
  criticalHigh?: number | undefined;
};

export function classifyResult(value: number, bounds: ResultBounds): ResultClassification {
  if (!Number.isFinite(value)) throw new ResultError('result value must be a finite number');

  let abnormal: Abnormal = 'normal';
  if (bounds.refLow !== undefined && value < bounds.refLow) abnormal = 'low';
  else if (bounds.refHigh !== undefined && value > bounds.refHigh) abnormal = 'high';

  const critical =
    (bounds.criticalLow !== undefined && value <= bounds.criticalLow) ||
    (bounds.criticalHigh !== undefined && value >= bounds.criticalHigh);

  return { abnormal, critical };
}

/** Whether a critical result is still open (released but not yet acknowledged). */
export function criticalIsOpen(critical: boolean, acknowledgedAt: string | null | undefined): boolean {
  return critical && !acknowledgedAt;
}

/** Minutes a critical result has been open — feeds the escalation timer (ORD-006). */
export function minutesOpen(releasedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - releasedAtMs) / 60_000));
}
