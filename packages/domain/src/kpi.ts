/**
 * KPI targets, thresholds & banding (MGT-004, MGT-005, pack §9.2).
 *
 * Targets are effective-dated configuration: the threshold in force on a date is
 * resolved the same way prices are. A KPI value is banded against its thresholds
 * into an RAG status (on_target / warning / critical), respecting whether higher
 * or lower is better. Period-over-period comparison is a pure delta with a trend.
 * All decision context; the numbers themselves come from the ledgers.
 */

export type KpiDirection = 'higher_better' | 'lower_better';

export type KpiTarget = {
  readonly kpiId: string;
  readonly version: number;
  readonly effectiveFrom: string; // ISO date, inclusive
  readonly effectiveTo?: string; // ISO date, exclusive
  readonly target?: number;
  readonly warnAt?: number; // threshold below/above which it is a warning
  readonly critAt?: number; // threshold below/above which it is critical
  readonly direction: KpiDirection;
  readonly commentary?: string;
};

export class KpiError extends Error {}

function isEffective(t: KpiTarget, onDate: string): boolean {
  if (onDate < t.effectiveFrom) return false;
  if (t.effectiveTo !== undefined && onDate >= t.effectiveTo) return false;
  return true;
}

/** The KPI target in force on a date (highest effective version), or null. */
export function resolveKpiTarget(targets: readonly KpiTarget[], kpiId: string, onDate: string): KpiTarget | null {
  return targets.filter((t) => t.kpiId === kpiId && isEffective(t, onDate)).sort((a, b) => b.version - a.version)[0] ?? null;
}

export type KpiStatus = 'on_target' | 'warning' | 'critical' | 'no_target';
export type KpiBand = { status: KpiStatus; colour: 'green' | 'amber' | 'red' | 'grey' };

/** Band a value against its target thresholds into an RAG status (MGT-004). */
export function bandKpi(value: number, target: KpiTarget | null): KpiBand {
  if (!target || target.warnAt === undefined || target.critAt === undefined) return { status: 'no_target', colour: 'grey' };
  const { warnAt, critAt, direction } = target;
  const ok = direction === 'higher_better' ? value >= warnAt : value <= warnAt;
  const warn = direction === 'higher_better' ? value >= critAt : value <= critAt;
  if (ok) return { status: 'on_target', colour: 'green' };
  if (warn) return { status: 'warning', colour: 'amber' };
  return { status: 'critical', colour: 'red' };
}

export type KpiTrend = 'up' | 'down' | 'flat';

export type KpiComparison = {
  kpiId: string;
  current: number;
  prior: number | null;
  delta: number | null;
  trend: KpiTrend;
  band: KpiBand;
};

/** Compare a current value to the prior period, with a trend and RAG band (MGT-005). */
export function compareKpi(kpiId: string, current: number, prior: number | null, target: KpiTarget | null): KpiComparison {
  const delta = prior === null ? null : current - prior;
  const trend: KpiTrend = delta === null || delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down';
  return { kpiId, current, prior, delta, trend, band: bandKpi(current, target) };
}
