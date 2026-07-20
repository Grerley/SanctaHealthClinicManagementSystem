/**
 * KPI target administration + period comparison (MGT-004, MGT-005). Targets are
 * effective-dated configuration (audited); snapshots record a KPI's value per
 * period so the current value can be compared to the prior period and banded
 * against its target. The domain resolves/bands; this layer persists + compares.
 */
import type { Pool } from 'pg';
import { uuidv7, resolveKpiTarget, compareKpi, type KpiTarget, type KpiComparison } from '@sancta/domain';

export class KpiAdminError extends Error {}

/** Define the next effective-dated target version for a KPI (MGT-004, audited). */
export async function setKpiTarget(
  pool: Pool,
  args: { kpiId: string; effectiveFrom: string; target?: number; warnAt?: number; critAt?: number; direction?: 'higher_better' | 'lower_better'; commentary?: string; by?: string },
): Promise<{ kpiId: string; version: number }> {
  if (!args.kpiId?.trim()) throw new KpiAdminError('a KPI id is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT version, to_char(effective_from,'YYYY-MM-DD') AS ef FROM organisation.kpi_target WHERE kpi_id=$1 ORDER BY version DESC LIMIT 1`, [args.kpiId]);
    const latest = cur.rows[0];
    if (latest && args.effectiveFrom <= latest.ef) throw new KpiAdminError(`new effective date must be after the current version's (${latest.ef})`);
    const next = latest ? latest.version + 1 : 1;
    if (latest) await client.query(`UPDATE organisation.kpi_target SET effective_to=$3 WHERE kpi_id=$1 AND version=$2`, [args.kpiId, latest.version, args.effectiveFrom]);
    await client.query(
      `INSERT INTO organisation.kpi_target (kpi_id, version, effective_from, target_value, warn_at, crit_at, direction, commentary, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [args.kpiId, next, args.effectiveFrom, args.target ?? null, args.warnAt ?? null, args.critAt ?? null, args.direction ?? 'higher_better', args.commentary ?? null, args.by ?? null],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'config','kpi_target',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by ?? null, uuidv7(), `[${args.kpiId}] v${next} target ${args.target ?? '—'} from ${args.effectiveFrom}`, 'kpi:' + args.kpiId + ':' + next],
    );
    await client.query('COMMIT');
    return { kpiId: args.kpiId, version: next };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function loadTargets(pool: Pool, kpiId: string): Promise<KpiTarget[]> {
  const r = await pool.query(
    `SELECT kpi_id, version, to_char(effective_from,'YYYY-MM-DD') AS ef, to_char(effective_to,'YYYY-MM-DD') AS et, target_value, warn_at, crit_at, direction, commentary
     FROM organisation.kpi_target WHERE kpi_id=$1 ORDER BY version`,
    [kpiId],
  );
  return r.rows.map((x) => ({
    kpiId: x.kpi_id,
    version: x.version,
    effectiveFrom: x.ef,
    ...(x.et ? { effectiveTo: x.et } : {}),
    ...(x.target_value === null ? {} : { target: Number(x.target_value) }),
    ...(x.warn_at === null ? {} : { warnAt: Number(x.warn_at) }),
    ...(x.crit_at === null ? {} : { critAt: Number(x.crit_at) }),
    direction: x.direction,
    ...(x.commentary ? { commentary: x.commentary } : {}),
  }));
}

/** Record a KPI value for a period (MGT-005). Overwrites the period's snapshot. */
export async function recordSnapshot(pool: Pool, args: { kpiId: string; period: string; value: number }): Promise<{ id: string }> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO organisation.kpi_snapshot (id, kpi_id, period, value) VALUES ($1,$2,$3,$4)
     ON CONFLICT (kpi_id, period) DO UPDATE SET value=$4, captured_at=now()`,
    [id, args.kpiId, args.period, args.value],
  );
  return { id };
}

/**
 * Compare a KPI's current period to the prior, banded against the effective
 * target (MGT-005). Uses recorded snapshots; the target is resolved as-of the
 * current period start.
 */
export async function kpiComparison(pool: Pool, args: { kpiId: string; period: string; priorPeriod: string }): Promise<KpiComparison & { refreshedAt: string }> {
  const snap = await pool.query(`SELECT period, value FROM organisation.kpi_snapshot WHERE kpi_id=$1 AND period IN ($2,$3)`, [args.kpiId, args.period, args.priorPeriod]);
  const current = snap.rows.find((r) => r.period === args.period);
  if (!current) throw new KpiAdminError(`no snapshot for ${args.kpiId} ${args.period}`);
  const prior = snap.rows.find((r) => r.period === args.priorPeriod);
  const target = resolveKpiTarget(await loadTargets(pool, args.kpiId), args.kpiId, `${args.period}-01`);
  const cmp = compareKpi(args.kpiId, Number(current.value), prior ? Number(prior.value) : null, target);
  return { ...cmp, refreshedAt: new Date().toISOString() };
}
