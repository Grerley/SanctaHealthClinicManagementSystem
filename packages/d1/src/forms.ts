/**
 * Structured clinical form administration + resolution on D1 (EHR-003). Forms are
 * versioned, effective-dated reference data; defining a new version closes the
 * prior one. The resolver returns the version in force on a date so an encounter
 * can validate its content against the exact form it was captured on. Ported from
 * the Postgres edge `forms.ts`.
 *
 * D1 translations: JSON schema stored as TEXT (parsed on read); boolean active →
 * INTEGER 0/1; new-version-closes-prior via a read-then-batch; the domain
 * resolveForm is reused unchanged.
 */
import { uuidv7, resolveForm, type FormDefinition, type FormField } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class FormAdminError extends Error {}

type Row = { form_code: string; version: number; title: string; schema: string; effective_from: string; effective_to: string | null; active: number };

function rowToDef(x: Row): FormDefinition {
  return {
    formCode: x.form_code,
    version: Number(x.version),
    title: x.title,
    fields: JSON.parse(x.schema) as FormField[],
    effectiveFrom: x.effective_from,
    ...(x.effective_to ? { effectiveTo: x.effective_to } : {}),
    active: Boolean(x.active),
  };
}

async function loadDefs(db: D1Database, formCode: string): Promise<FormDefinition[]> {
  const rows = await many<Row>(db, `SELECT form_code, version, title, schema, effective_from, effective_to, active FROM clinical_form_definition WHERE form_code=? ORDER BY version`, [formCode]);
  return rows.map(rowToDef);
}

/** The form version in force on a date (throws if none). */
export async function formAsOf(db: D1Database, formCode: string, onDate: string): Promise<FormDefinition> {
  return resolveForm(await loadDefs(db, formCode), formCode, onDate);
}

/** Define the next version of a form, closing the prior version at the new date. */
export async function defineForm(
  db: D1Database,
  args: { formCode: string; title: string; fields: FormField[]; effectiveFrom: string; by?: string },
): Promise<{ formCode: string; version: number }> {
  if (!args.formCode?.trim() || !args.title?.trim()) throw new FormAdminError('form code and title are required');
  if (!Array.isArray(args.fields) || args.fields.length === 0) throw new FormAdminError('a form needs at least one field');
  const latest = await one<{ version: number; ef: string }>(db, `SELECT version, effective_from AS ef FROM clinical_form_definition WHERE form_code=? ORDER BY version DESC LIMIT 1`, [args.formCode]);
  if (latest && args.effectiveFrom <= latest.ef) throw new FormAdminError(`new effective date must be after the current version's (${latest.ef})`);
  const next = latest ? Number(latest.version) + 1 : 1;
  const batch = [];
  if (latest) batch.push(stmt(db, `UPDATE clinical_form_definition SET effective_to=? WHERE form_code=? AND version=?`, [args.effectiveFrom, args.formCode, latest.version]));
  batch.push(stmt(db, `INSERT INTO clinical_form_definition (form_code, version, title, schema, effective_from, created_by) VALUES (?,?,?,?,?,?)`,
    [args.formCode, next, args.title, JSON.stringify(args.fields), args.effectiveFrom, args.by ?? null]));
  batch.push(stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config','form_definition',?,'success',?,?)`,
    [uuidv7(), args.by ?? null, uuidv7(), `[${args.formCode}] v${next}: ${args.title}`, 'form:' + args.formCode + ':' + next]));
  await db.batch(batch);
  return { formCode: args.formCode, version: next };
}

export async function listForms(db: D1Database, onDate?: string): Promise<FormDefinition[]> {
  const day = onDate ?? new Date().toISOString().slice(0, 10);
  const codes = await many<{ form_code: string }>(db, `SELECT DISTINCT form_code FROM clinical_form_definition ORDER BY form_code`);
  const out: FormDefinition[] = [];
  for (const row of codes) {
    const defs = await loadDefs(db, row.form_code);
    const eff = defs.filter((d) => d.effectiveFrom <= day && (d.effectiveTo === undefined || day < d.effectiveTo)).sort((a, b) => b.version - a.version)[0];
    if (eff && eff.active) out.push(eff);
  }
  return out;
}
