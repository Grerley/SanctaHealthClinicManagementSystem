/**
 * Structured clinical form administration + resolution (EHR-003). Forms are
 * versioned, effective-dated reference data; defining a new version closes the
 * prior one. The resolver returns the version in force on a date so an encounter
 * can validate its content against the exact form it was captured on.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7, resolveForm, type FormDefinition, type FormField } from '@sancta/domain';

export class FormAdminError extends Error {}

function rowToDef(x: {
  form_code: string;
  version: number;
  title: string;
  schema: FormField[];
  effective_from: string;
  effective_to: string | null;
  active: boolean;
}): FormDefinition {
  return {
    formCode: x.form_code,
    version: x.version,
    title: x.title,
    fields: x.schema,
    effectiveFrom: x.effective_from,
    ...(x.effective_to ? { effectiveTo: x.effective_to } : {}),
    active: x.active,
  };
}

async function loadDefs(client: Pool | PoolClient, formCode: string): Promise<FormDefinition[]> {
  const r = await client.query(
    `SELECT form_code, version, title, schema,
            to_char(effective_from,'YYYY-MM-DD') AS effective_from,
            to_char(effective_to,'YYYY-MM-DD') AS effective_to, active
     FROM clinical.form_definition WHERE form_code=$1 ORDER BY version`,
    [formCode],
  );
  return r.rows.map(rowToDef);
}

/** The form version in force on a date (throws if none). */
export async function formAsOf(client: Pool | PoolClient, formCode: string, onDate: string): Promise<FormDefinition> {
  return resolveForm(await loadDefs(client, formCode), formCode, onDate);
}

/** Define the next version of a form, closing the prior version at the new date. */
export async function defineForm(
  pool: Pool,
  args: { formCode: string; title: string; fields: FormField[]; effectiveFrom: string; by?: string },
): Promise<{ formCode: string; version: number }> {
  if (!args.formCode?.trim() || !args.title?.trim()) throw new FormAdminError('form code and title are required');
  if (!Array.isArray(args.fields) || args.fields.length === 0) throw new FormAdminError('a form needs at least one field');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT version, to_char(effective_from,'YYYY-MM-DD') AS ef FROM clinical.form_definition WHERE form_code=$1 ORDER BY version DESC LIMIT 1`, [args.formCode]);
    const latest = cur.rows[0];
    if (latest && args.effectiveFrom <= latest.ef) throw new FormAdminError(`new effective date must be after the current version's (${latest.ef})`);
    const next = latest ? latest.version + 1 : 1;
    if (latest) await client.query(`UPDATE clinical.form_definition SET effective_to=$3 WHERE form_code=$1 AND version=$2`, [args.formCode, latest.version, args.effectiveFrom]);
    await client.query(
      `INSERT INTO clinical.form_definition (form_code, version, title, schema, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [args.formCode, next, args.title, JSON.stringify(args.fields), args.effectiveFrom, args.by ?? null],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'config','form_definition',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by ?? null, uuidv7(), `[${args.formCode}] v${next}: ${args.title}`, 'form:' + args.formCode + ':' + next],
    );
    await client.query('COMMIT');
    return { formCode: args.formCode, version: next };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listForms(pool: Pool, onDate?: string): Promise<FormDefinition[]> {
  const day = onDate ?? new Date().toISOString().slice(0, 10);
  const r = await pool.query(`SELECT DISTINCT form_code FROM clinical.form_definition ORDER BY form_code`);
  const out: FormDefinition[] = [];
  for (const row of r.rows) {
    const defs = await loadDefs(pool, row.form_code);
    const eff = defs.filter((d) => d.effectiveFrom <= day && (d.effectiveTo === undefined || day < d.effectiveTo)).sort((a, b) => b.version - a.version)[0];
    if (eff && eff.active) out.push(eff);
  }
  return out;
}
