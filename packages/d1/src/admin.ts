/**
 * Versioned config releases, feature flags & system health on D1 (ADM-003/005/
 * 006/008).
 *
 * ADM-003: config changes move draft -> test -> approved -> published with a
 * maker-checker approval; publishing supersedes the prior published release, and
 * rollback re-publishes it. ADM-006: feature flags gate staged rollout by site/
 * role (evaluated by the domain). ADM-005: a system-health report aggregates the
 * outbox backlog. ADM-008: help topics served locally. Ported from the Postgres
 * edge `admin.ts`.
 *
 * D1 translations: interactive tx + FOR UPDATE → read status then apply the guarded
 * transition; Postgres text[] → JSON TEXT (parsed for the domain evaluator);
 * running version via COALESCE(MAX)+1. In the single-Worker/D1 model there is no
 * edge<->cloud sync layer, so integration-queue and conflict signals report 0.
 */
import { uuidv7, assertSegregation, featureEnabled, type FeatureFlag, type Role } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

export class AdminError extends Error {}

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

// --- ADM-003 config releases -----------------------------------------------

const RELEASE_TRANSITIONS: Record<string, string[]> = {
  draft: ['test'],
  test: ['approved', 'draft'],
  approved: ['published'],
  published: ['rolled_back'],
  rolled_back: [],
};

export async function createRelease(db: D1Database, args: { name: string; payload: unknown; by: string }): Promise<{ id: string; version: number }> {
  if (!args.name?.trim()) throw new AdminError('a release name is required');
  const cur = await one<{ v: number }>(db, `SELECT COALESCE(MAX(version),0) AS v FROM organisation_config_release WHERE name=?`, [args.name]);
  const version = Number(cur?.v ?? 0) + 1;
  const id = uuidv7();
  await db.prepare(`INSERT INTO organisation_config_release (id, name, version, payload, status, created_by) VALUES (?,?,?,?,'draft',?)`)
    .bind(id, args.name, version, JSON.stringify(args.payload), args.by).run();
  return { id, version };
}

/** Promote a release along its lifecycle. Approval is maker-checker (ADM-003). */
export async function promoteRelease(db: D1Database, args: { id: string; to: string; by: string }): Promise<{ id: string; status: string }> {
  const r = await one<{ name: string; status: string; created_by: string | null }>(db, `SELECT name, status, created_by FROM organisation_config_release WHERE id=?`, [args.id]);
  if (!r) throw new AdminError('release not found');
  if (!(RELEASE_TRANSITIONS[r.status] ?? []).includes(args.to)) throw new AdminError(`cannot move a ${r.status} release to ${args.to}`);
  if (args.to === 'approved') assertSegregation(args.by, r.created_by ?? ''); // checker != maker

  const auditStmt = stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config','config_release',?,'success',?,?)`,
    [uuidv7(), args.by, args.id, `${r.status} -> ${args.to}`, 'release:' + args.id + ':' + uuidv7()]);

  if (args.to === 'published') {
    await db.batch([
      stmt(db, `UPDATE organisation_config_release SET status='rolled_back' WHERE name=? AND status='published'`, [r.name]),
      stmt(db, `UPDATE organisation_config_release SET status='published', published_at=${NOW} WHERE id=?`, [args.id]),
      auditStmt,
    ]);
  } else {
    await db.batch([
      stmt(db, `UPDATE organisation_config_release SET status=?, approved_by=CASE WHEN ?='approved' THEN ? ELSE approved_by END WHERE id=?`, [args.to, args.to, args.by, args.id]),
      auditStmt,
    ]);
  }
  return { id: args.id, status: args.to };
}

/** Roll back the currently-published release, re-publishing the prior one (ADM-003). */
export async function rollbackRelease(db: D1Database, args: { name: string; by: string }): Promise<{ published: string | null }> {
  const cur = await one<{ id: string; version: number }>(db, `SELECT id, version FROM organisation_config_release WHERE name=? AND status='published'`, [args.name]);
  if (!cur) throw new AdminError('no published release to roll back');
  const prior = await one<{ id: string }>(db, `SELECT id FROM organisation_config_release WHERE name=? AND status='rolled_back' AND version < ? ORDER BY version DESC LIMIT 1`, [args.name, cur.version]);
  const batch = [stmt(db, `UPDATE organisation_config_release SET status='rolled_back' WHERE id=?`, [cur.id])];
  let published: string | null = null;
  if (prior) {
    published = prior.id;
    batch.push(stmt(db, `UPDATE organisation_config_release SET status='published', published_at=${NOW} WHERE id=?`, [prior.id]));
  }
  batch.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config','config_release',?,'success','rollback',?)`,
    [uuidv7(), args.by, cur.id, 'rollback:' + cur.id]));
  await db.batch(batch);
  return { published };
}

export async function currentConfig(db: D1Database, name: string): Promise<{ version: number; payload: unknown } | null> {
  const r = await one<{ version: number; payload: string }>(db, `SELECT version, payload FROM organisation_config_release WHERE name=? AND status='published' ORDER BY version DESC LIMIT 1`, [name]);
  return r ? { version: Number(r.version), payload: JSON.parse(r.payload) } : null;
}

// --- ADM-006 feature flags -------------------------------------------------

export async function setFeatureFlag(db: D1Database, args: { key: string; enabled: boolean; sites?: string[]; roles?: string[] }): Promise<{ key: string }> {
  await db.prepare(`INSERT INTO organisation_feature_flag (key, enabled, sites, roles, updated_at) VALUES (?,?,?,?, ${NOW})
    ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled, sites=excluded.sites, roles=excluded.roles, updated_at=excluded.updated_at`)
    .bind(args.key, args.enabled ? 1 : 0, JSON.stringify(args.sites ?? []), JSON.stringify(args.roles ?? [])).run();
  return { key: args.key };
}

/** Evaluate a flag for a caller context (ADM-006). Unknown flag → off. */
export async function evaluateFlag(db: D1Database, key: string, ctx: { site?: string | null; roles?: Role[] }): Promise<boolean> {
  const r = await one<{ key: string; enabled: number; sites: string; roles: string }>(db, `SELECT key, enabled, sites, roles FROM organisation_feature_flag WHERE key=?`, [key]);
  if (!r) return false;
  const flag: FeatureFlag = { key: r.key, enabled: Boolean(r.enabled), sites: JSON.parse(r.sites), roles: JSON.parse(r.roles) };
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
export async function systemHealth(db: D1Database): Promise<SystemHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const pending = Number((await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM security_sync_outbox_item WHERE sync_state='queued'`))?.n ?? 0);
    // The single-Worker/D1 deployment has no separate integration-queue or
    // conflict-case store, so those signals are 0 here.
    return { database: 'ok', pendingSync: pending, integrationQueue: { queued: 0, dead: 0 }, openConflicts: 0, status: 'ok', checkedAt };
  } catch {
    return { database: 'unreachable', pendingSync: -1, integrationQueue: { queued: -1, dead: -1 }, openConflicts: -1, status: 'attention', checkedAt };
  }
}

// --- Local help & onboarding (ADM-008) --------------------------------------

export type HelpTopic = { slug: string; title: string; category: string; body: string; stepOrder: number | null };

/** A single help topic served locally (ADM-008, offline). */
export async function getHelpTopic(db: D1Database, slug: string): Promise<HelpTopic | null> {
  const x = await one<{ slug: string; title: string; category: string; body: string; step_order: number | null }>(db, `SELECT slug, title, category, body, step_order FROM organisation_help_topic WHERE slug=?`, [slug]);
  return x ? { slug: x.slug, title: x.title, category: x.category, body: x.body, stepOrder: x.step_order } : null;
}

/** List help topics, optionally by category; onboarding steps come back in order (ADM-008). */
export async function listHelpTopics(db: D1Database, category?: string): Promise<HelpTopic[]> {
  const rows = category
    ? await many<{ slug: string; title: string; category: string; body: string; step_order: number | null }>(db, `SELECT slug, title, category, body, step_order FROM organisation_help_topic WHERE category=? ORDER BY step_order IS NULL, step_order, title`, [category])
    : await many<{ slug: string; title: string; category: string; body: string; step_order: number | null }>(db, `SELECT slug, title, category, body, step_order FROM organisation_help_topic ORDER BY category, step_order IS NULL, step_order, title`);
  return rows.map((x) => ({ slug: x.slug, title: x.title, category: x.category, body: x.body, stepOrder: x.step_order }));
}
