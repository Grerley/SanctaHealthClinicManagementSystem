/**
 * Versioned structured clinical forms (EHR-003, pack §7.4).
 *
 * Clinical content (history/examination/assessment/plan) is captured through
 * structured forms whose DEFINITION is versioned and effective-dated. An encounter
 * records which form version it used, so a later revision of the form never
 * changes what was recorded. This module holds the pure schema + a validator that
 * checks submitted content against the form's fields (required, typed, coded).
 */

export type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'code';

export type FormField = {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  /** Permitted values for a 'code' field. */
  readonly options?: readonly string[];
};

export type FormDefinition = {
  readonly formCode: string;
  readonly version: number;
  readonly title: string;
  readonly fields: readonly FormField[];
  readonly effectiveFrom: string; // ISO date, inclusive
  readonly effectiveTo?: string; // ISO date, exclusive
  readonly active?: boolean;
};

export type FormIssue = { key: string; reason: string };
export type FormValidation = { ok: boolean; issues: FormIssue[] };

export class FormError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function typeOk(field: FormField, value: unknown): boolean {
  switch (field.type) {
    case 'text':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && ISO_DATE.test(value);
    case 'code':
      return typeof value === 'string' && (field.options === undefined || field.options.includes(value));
    default:
      return false;
  }
}

/**
 * Validate submitted content against a form definition. Reports every issue:
 * missing required fields, wrong types, invalid codes, and unknown keys (content
 * that does not belong to this form version).
 */
export function validateFormContent(def: FormDefinition, content: Readonly<Record<string, unknown>>): FormValidation {
  const issues: FormIssue[] = [];
  const known = new Set(def.fields.map((f) => f.key));

  for (const field of def.fields) {
    const present = Object.prototype.hasOwnProperty.call(content, field.key) && content[field.key] !== null && content[field.key] !== undefined;
    if (!present) {
      if (field.required) issues.push({ key: field.key, reason: `${field.key} is required` });
      continue;
    }
    if (!typeOk(field, content[field.key])) {
      const detail = field.type === 'code' && field.options ? ` (one of ${field.options.join(', ')})` : '';
      issues.push({ key: field.key, reason: `${field.key} must be ${field.type}${detail}` });
    }
  }
  for (const key of Object.keys(content)) {
    if (!known.has(key)) issues.push({ key, reason: `${key} is not a field of ${def.formCode} v${def.version}` });
  }
  return { ok: issues.length === 0, issues };
}

export function assertFormContent(def: FormDefinition, content: Readonly<Record<string, unknown>>): void {
  const r = validateFormContent(def, content);
  if (!r.ok) throw new FormError(r.issues.map((i) => `${i.key}: ${i.reason}`).join('; '));
}

function isEffective(d: FormDefinition, onDate: string): boolean {
  if (onDate < d.effectiveFrom) return false;
  if (d.effectiveTo !== undefined && onDate >= d.effectiveTo) return false;
  return true;
}

/** Resolve the form version in force on a date (highest effective version). */
export function resolveForm(defs: readonly FormDefinition[], formCode: string, onDate: string): FormDefinition {
  const found = defs
    .filter((d) => d.formCode === formCode && isEffective(d, onDate))
    .sort((a, b) => b.version - a.version)[0];
  if (!found) throw new FormError(`no effective form ${formCode} on ${onDate}`);
  return found;
}
