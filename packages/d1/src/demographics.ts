/**
 * Demographic capture policy administration on D1 (PAT-004). Loads the
 * configurable field policy and lets an administrator revise it (audited). The
 * policy is consumed by patient registration (domain `validateDemographics`) to
 * validate mandatory / unknown / declined fields. Ported from the Postgres edge
 * `demographics.ts`.
 *
 * D1 translations: booleans → INTEGER 0/1; upsert via ON CONFLICT; the config
 * change + audit post atomically via db.batch().
 */
import { uuidv7, type DemographicPolicy, type FieldRule } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { many, stmt } from './query.ts';

export class DemographicPolicyError extends Error {}

type Row = { field: string; required: number; allow_unknown: number; allow_declined: number };

export async function loadPolicy(db: D1Database): Promise<DemographicPolicy> {
  const rows = await many<Row>(db, `SELECT field, required, allow_unknown, allow_declined FROM identity_demographic_field ORDER BY display_order, field`);
  const fields: FieldRule[] = rows.map((x) => ({
    field: x.field,
    required: Boolean(x.required),
    ...(x.allow_unknown ? { allowUnknown: true } : {}),
    ...(x.allow_declined ? { allowDeclined: true } : {}),
  }));
  return { fields };
}

export async function listPolicy(db: D1Database): Promise<Array<{ field: string; required: boolean; allowUnknown: boolean; allowDeclined: boolean }>> {
  const rows = await many<Row>(db, `SELECT field, required, allow_unknown, allow_declined, display_order FROM identity_demographic_field ORDER BY display_order, field`);
  return rows.map((x) => ({ field: x.field, required: Boolean(x.required), allowUnknown: Boolean(x.allow_unknown), allowDeclined: Boolean(x.allow_declined) }));
}

/** Revise a field's rule (config change, audited). Creates the field if new. */
export async function setFieldRule(
  db: D1Database,
  args: { field: string; required: boolean; allowUnknown?: boolean; allowDeclined?: boolean; displayOrder?: number; by?: string },
): Promise<{ field: string }> {
  if (!args.field?.trim()) throw new DemographicPolicyError('field is required');
  await db.batch([
    stmt(db, `INSERT INTO identity_demographic_field (field, required, allow_unknown, allow_declined, display_order) VALUES (?,?,?,?,?)
      ON CONFLICT(field) DO UPDATE SET required=excluded.required, allow_unknown=excluded.allow_unknown, allow_declined=excluded.allow_declined, display_order=excluded.display_order`,
      [args.field, args.required ? 1 : 0, args.allowUnknown ? 1 : 0, args.allowDeclined ? 1 : 0, args.displayOrder ?? 100]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config','demographic_field',?,'success',?,?)`,
      [uuidv7(), args.by ?? null, uuidv7(), `[${args.field}] required=${args.required} unknown=${args.allowUnknown ?? false} declined=${args.allowDeclined ?? false}`, 'demofield:' + args.field + ':' + uuidv7()]),
  ]);
  return { field: args.field };
}
