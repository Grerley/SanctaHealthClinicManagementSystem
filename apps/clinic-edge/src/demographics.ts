/**
 * Demographic capture policy administration (PAT-004). Loads the configurable
 * field policy and lets an administrator revise it (audited). The policy is
 * consumed by patient registration to validate mandatory/unknown/declined fields.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7, type DemographicPolicy, type FieldRule } from '@sancta/domain';

export class DemographicPolicyError extends Error {}

export async function loadPolicy(client: Pool | PoolClient): Promise<DemographicPolicy> {
  const r = await client.query(
    `SELECT field, required, allow_unknown, allow_declined FROM identity.demographic_field ORDER BY display_order, field`,
  );
  const fields: FieldRule[] = r.rows.map((x) => ({
    field: x.field,
    required: x.required,
    ...(x.allow_unknown ? { allowUnknown: true } : {}),
    ...(x.allow_declined ? { allowDeclined: true } : {}),
  }));
  return { fields };
}

export async function listPolicy(pool: Pool): Promise<Array<{ field: string; required: boolean; allowUnknown: boolean; allowDeclined: boolean }>> {
  const r = await pool.query(`SELECT field, required, allow_unknown, allow_declined, display_order FROM identity.demographic_field ORDER BY display_order, field`);
  return r.rows.map((x) => ({ field: x.field, required: x.required, allowUnknown: x.allow_unknown, allowDeclined: x.allow_declined }));
}

/** Revise a field's rule (config change, audited). Creates the field if new. */
export async function setFieldRule(
  pool: Pool,
  args: { field: string; required: boolean; allowUnknown?: boolean; allowDeclined?: boolean; displayOrder?: number; by?: string },
): Promise<{ field: string }> {
  if (!args.field?.trim()) throw new DemographicPolicyError('field is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO identity.demographic_field (field, required, allow_unknown, allow_declined, display_order)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (field) DO UPDATE SET required=$2, allow_unknown=$3, allow_declined=$4, display_order=$5`,
      [args.field, args.required, args.allowUnknown ?? false, args.allowDeclined ?? false, args.displayOrder ?? 100],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'config','demographic_field',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by ?? null, uuidv7(), `[${args.field}] required=${args.required} unknown=${args.allowUnknown ?? false} declined=${args.allowDeclined ?? false}`, 'demofield:' + args.field + ':' + uuidv7()],
    );
    await client.query('COMMIT');
    return { field: args.field };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
