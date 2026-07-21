/**
 * Versioned config releases, feature flags & system health (ADM-003/005/006).
 *
 * ADM-003: config changes move through draft → test → approved → published with a
 * maker-checker approval; publishing supersedes the prior published release, and
 * rollback re-publishes it. ADM-006: feature flags gate staged rollout by site/
 * role (evaluated by the domain). ADM-005: a system-health report aggregates
 * database, sync backlog, integration queue and conflict signals.
 */
import type { Pool } from 'pg';
import { uuidv7, assertSegregation, featureEnabled, type FeatureFlag, type Role } from '@sancta/domain';

export class AdminError extends Error {}

// --- ADM-003 config releases -----------------------------------------------

const RELEASE_TRANSITIONS: Record<string, string[]> = {
  draft: ['test'],
  test: ['approved', 'draft'],
  approved: ['published'],
  published: ['rolled_back'],
  rolled_back: [],
};

export async function createRelease(pool: Pool, args: { name: string; payload: unknown; by: string }): Promise<{ id: string; version: number }> {
  if (!args.name?.trim()) throw new AdminError('a release name is required');
  const cur = await pool.query(`SELECT coalesce(max(version),0) AS v FROM organisation.config_release WHERE name=$1`, [args.name]);
  const version = Number(cur.rows[0].v) + 1;
  const id = uuidv7();
  await pool.query(`INSERT INTO organisation.config_release (id, name, version, payload, status, created_by) VALUES ($1,$2,$3,$4,'draft',$5)`, [id, args.name, version, JSON.stringify(args.payload), args.by]);
  return { id, version };
}

/** Promote a release along its lifecycle. Approval is maker-checker (ADM-003). */
export async function promoteRelease(pool: Pool, args: { id: string; to: string; by: string }): Promise<{ id: string; status: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT name, status, created_by FROM organisation.config_release WHERE id=$1 FOR UPDATE`, [args.id]);
    if (r.rowCount === 0) throw new AdminError('release not found');
    const { name, status, created_by } = r.rows[0];
    if (!(RELEASE_TRANSITIONS[status] ?? []).includes(args.to)) throw new AdminError(`cannot move a ${status} release to ${args.to}`);
    if (args.to === 'approved') assertSegregation(args.by, created_by); // checker != maker

    if (args.to === 'published') {
      // Supersede any currently-published release of the same name.
      await client.query(`UPDATE organisation.config_release SET status='rolled_back' WHERE name=$1 AND status='published'`, [name]);
      await client.query(`UPDATE organisation.config_release SET status='published', published_at=now() WHERE id=$1`, [args.id]);
    } else {
      await client.query(`UPDATE organisation.config_release SET status=$2, approved_by=CASE WHEN $2='approved' THEN $3 ELSE approved_by END WHERE id=$1`, [args.id, args.to, args.by]);
    }
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'config','config_release',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by, args.id, `${status} → ${args.to}`, 'release:' + args.id + ':' + uuidv7()],
    );
    await client.query('COMMIT');
    return { id: args.id, status: args.to };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Roll back the currently-published release, re-publishing the prior one (ADM-003). */
export async function rollbackRelease(pool: Pool, args: { name: string; by: string }): Promise<{ published: string | null }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT id, version FROM organisation.config_release WHERE name=$1 AND status='published' FOR UPDATE`, [args.name]);
    if (cur.rowCount === 0) throw new AdminError('no published release to roll back');
    await client.query(`UPDATE organisation.config_release SET status='rolled_back' WHERE id=$1`, [cur.rows[0].id]);
    const prior = await client.query(`SELECT id FROM organisation.config_release WHERE name=$1 AND status='rolled_back' AND version < $2 ORDER BY version DESC LIMIT 1`, [args.name, cur.rows[0].version]);
    let published: string | null = null;
    if ((prior.rowCount ?? 0) > 0) {
      published = prior.rows[0].id;
      await client.query(`UPDATE organisation.config_release SET status='published', published_at=now() WHERE id=$1`, [published]);
    }
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'config','config_release',$3,'success','rollback', now(), $4)`,
      [uuidv7(), args.by, cur.rows[0].id, 'rollback:' + cur.rows[0].id],
    );
    await client.query('COMMIT');
    return { published };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function currentConfig(pool: Pool, name: string): Promise<{ version: number; payload: unknown } | null> {
  const r = await pool.query(`SELECT version, payload FROM organisation.config_release WHERE name=$1 AND status='published' ORDER BY version DESC LIMIT 1`, [name]);
  return r.rowCount ? { version: r.rows[0].version, payload: r.rows[0].payload } : null;
}

// --- ADM-006 feature flags -------------------------------------------------

export async function setFeatureFlag(pool: Pool, args: { key: string; enabled: boolean; sites?: string[]; roles?: string[] }): Promise<{ key: string }> {
  await pool.query(
    `INSERT INTO organisation.feature_flag (key, enabled, sites, roles, updated_at) VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (key) DO UPDATE SET enabled=$2, sites=$3, roles=$4, updated_at=now()`,
    [args.key, args.enabled, args.sites ?? [], args.roles ?? []],
  );
  return { key: args.key };
}

/** Evaluate a flag for a caller context (ADM-006). Unknown flag → off. */
export async function evaluateFlag(pool: Pool, key: string, ctx: { site?: string | null; roles?: Role[] }): Promise<boolean> {
  const r = await pool.query(`SELECT key, enabled, sites, roles FROM organisation.feature_flag WHERE key=$1`, [key]);
  if (r.rowCount === 0) return false;
  const flag: FeatureFlag = { key: r.rows[0].key, enabled: r.rows[0].enabled, sites: r.rows[0].sites, roles: r.rows[0].roles };
  return featureEnabled(flag, ctx);
}

// --- ADM-005 system health -------------------------------------------------

export type SystemHealth = {
  database: 'ok' | 'unreachable';
  pendingSync: number;
  integrationQueue: { queued: number; dead: number };
  openConflicts: number;
  status: 'ok' | 'attention';
  checkedAt: string;
};

/** Aggregate operational health signals (ADM-005). */
export async function systemHealth(pool: Pool): Promise<SystemHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const pending = Number((await pool.query(`SELECT count(*)::int AS n FROM security_sync.outbox_item WHERE sync_state='queued'`)).rows[0].n);
    const iq = await pool.query(`SELECT status, count(*)::int AS n FROM security_sync.integration_queue GROUP BY status`);
    const queued = Number(iq.rows.find((r) => r.status === 'queued')?.n ?? 0);
    const dead = Number(iq.rows.find((r) => r.status === 'dead')?.n ?? 0);
    const conflicts = Number((await pool.query(`SELECT count(*)::int AS n FROM security_sync.conflict_case WHERE status='open'`)).rows[0].n);
    const status = dead > 0 || conflicts > 0 ? 'attention' : 'ok';
    return { database: 'ok', pendingSync: pending, integrationQueue: { queued, dead }, openConflicts: conflicts, status, checkedAt };
  } catch {
    return { database: 'unreachable', pendingSync: -1, integrationQueue: { queued: -1, dead: -1 }, openConflicts: -1, status: 'attention', checkedAt };
  }
}

// --- Local help & onboarding (ADM-008) --------------------------------------

export type HelpTopic = { slug: string; title: string; category: string; body: string; stepOrder: number | null };

/** A single help topic served locally from the edge (ADM-008, offline). */
export async function getHelpTopic(pool: Pool, slug: string): Promise<HelpTopic | null> {
  const r = await pool.query(`SELECT slug, title, category, body, step_order FROM organisation.help_topic WHERE slug=$1`, [slug]);
  if (r.rows.length === 0) return null;
  const x = r.rows[0];
  return { slug: x.slug, title: x.title, category: x.category, body: x.body, stepOrder: x.step_order };
}

/** List help topics, optionally by category; onboarding steps come back in order (ADM-008). */
export async function listHelpTopics(pool: Pool, category?: string): Promise<HelpTopic[]> {
  const r = category
    ? await pool.query(`SELECT slug, title, category, body, step_order FROM organisation.help_topic WHERE category=$1 ORDER BY step_order NULLS LAST, title`, [category])
    : await pool.query(`SELECT slug, title, category, body, step_order FROM organisation.help_topic ORDER BY category, step_order NULLS LAST, title`);
  return r.rows.map((x) => ({ slug: x.slug, title: x.title, category: x.category, body: x.body, stepOrder: x.step_order }));
}
