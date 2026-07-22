/**
 * KPI target administration + period comparison on D1 (MGT-004, MGT-005). Targets
 * are effective-dated configuration (audited); snapshots record a KPI's value per
 * period so the current value can be compared to the prior period and banded
 * against its target. The domain resolves/bands; this layer persists + compares.
 * Ported from the Postgres edge `kpi.ts`.
 *
 * D1 translations: interactive tx → read-then-batch; new target version closes the
 * prior effective_to; snapshot upsert via ON CONFLICT; the domain resolveKpiTarget/
 * compareKpi are reused unchanged.
 */
import { uuidv7, resolveKpiTarget, compareKpi, type KpiTarget, type KpiComparison } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class KpiAdminError extends Error {}

/** Define the next effective-dated target version for a KPI (MGT-004, audited). */
export async function setKpiTarget(
  db: D1Database,
  args: { kpiId: string; effectiveFrom: string; target?: number; warnAt?: number; critAt?: number; direction?: 'higher_better' | 'lower_better'; commentary?: string; by?: string },
): Promise<{ kpiId: string; version: number }> {
  if (!args.kpiId?.trim()) throw new KpiAdminError('a KPI id is required');
  const latest = await one<{ version: number; ef: string }>(db, `SELECT version, effective_from AS ef FROM organisation_kpi_target WHERE kpi_id=? ORDER BY version DESC LIMIT 1`, [args.kpiId]);
  if (latest && args.effectiveFrom <= latest.ef) throw new KpiAdminError(`new effective date must be after the current version's (${latest.ef})`);
  const next = latest ? Number(latest.version) + 1 : 1;
  const batch = [];
  if (latest) batch.push(stmt(db, `UPDATE organisation_kpi_target SET effective_to=? WHERE kpi_id=? AND version=?`, [args.effectiveFrom, args.kpiId, latest.version]));
  batch.push(stmt(db, `INSERT INTO organisation_kpi_target (kpi_id, version, effective_from, target_value, warn_at, crit_at, direction, commentary, changed_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [args.kpiId, next, args.effectiveFrom, args.target ?? null, args.warnAt ?? null, args.critAt ?? null, args.direction ?? 'higher_better', args.commentary ?? null, args.by ?? null]));
  batch.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config','kpi_target',?,'success',?,?)`,
    [uuidv7(), args.by ?? null, uuidv7(), `[${args.kpiId}] v${next} target ${args.target ?? '-'} from ${args.effectiveFrom}`, 'kpi:' + args.kpiId + ':' + next]));
  await db.batch(batch);
  return { kpiId: args.kpiId, version: next };
}

async function loadTargets(db: D1Database, kpiId: string): Promise<KpiTarget[]> {
  const rows = await many<{ kpi_id: string; version: number; ef: string; et: string | null; target_value: number | null; warn_at: number | null; crit_at: number | null; direction: string; commentary: string | null }>(db,
    `SELECT kpi_id, version, effective_from AS ef, effective_to AS et, target_value, warn_at, crit_at, direction, commentary FROM organisation_kpi_target WHERE kpi_id=? ORDER BY version`, [kpiId]);
  return rows.map((x) => ({
    kpiId: x.kpi_id,
    version: Number(x.version),
    effectiveFrom: x.ef,
    ...(x.et ? { effectiveTo: x.et } : {}),
    ...(x.target_value === null ? {} : { target: Number(x.target_value) }),
    ...(x.warn_at === null ? {} : { warnAt: Number(x.warn_at) }),
    ...(x.crit_at === null ? {} : { critAt: Number(x.crit_at) }),
    direction: x.direction as 'higher_better' | 'lower_better',
    ...(x.commentary ? { commentary: x.commentary } : {}),
  }));
}

/** Record a KPI value for a period (MGT-005). Overwrites the period's snapshot. */
export async function recordSnapshot(db: D1Database, args: { kpiId: string; period: string; value: number }): Promise<{ id: string }> {
  const id = uuidv7();
  await db.prepare(`INSERT INTO organisation_kpi_snapshot (id, kpi_id, period, value) VALUES (?,?,?,?)
    ON CONFLICT(kpi_id, period) DO UPDATE SET value=excluded.value, captured_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
    .bind(id, args.kpiId, args.period, args.value).run();
  return { id };
}

/**
 * Compare a KPI's current period to the prior, banded against the effective
 * target (MGT-005). Uses recorded snapshots; the target is resolved as-of the
 * current period start.
 */
export async function kpiComparison(db: D1Database, args: { kpiId: string; period: string; priorPeriod: string }): Promise<KpiComparison & { refreshedAt: string }> {
  const snaps = await many<{ period: string; value: number }>(db, `SELECT period, value FROM organisation_kpi_snapshot WHERE kpi_id=? AND period IN (?,?)`, [args.kpiId, args.period, args.priorPeriod]);
  const current = snaps.find((r) => r.period === args.period);
  if (!current) throw new KpiAdminError(`no snapshot for ${args.kpiId} ${args.period}`);
  const prior = snaps.find((r) => r.period === args.priorPeriod);
  const target = resolveKpiTarget(await loadTargets(db, args.kpiId), args.kpiId, `${args.period}-01`);
  const cmp = compareKpi(args.kpiId, Number(current.value), prior ? Number(prior.value) : null, target);
  return { ...cmp, refreshedAt: new Date().toISOString() };
}
