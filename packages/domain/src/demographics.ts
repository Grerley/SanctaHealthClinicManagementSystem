/**
 * Configurable demographic capture policy (PAT-004, pack §6.1).
 *
 * Each demographic field is governed: it may be mandatory, and a mandatory field
 * can be satisfied either by a real value or — where the policy permits — by an
 * explicit "unknown" or "declined" marker. The point is that a required field is
 * never silently skipped: the registrar must supply it or consciously mark why it
 * is absent (a data-quality control, not a hard block that loses the patient).
 */

export type Marker = 'unknown' | 'declined';

export type FieldRule = {
  readonly field: string;
  readonly required: boolean;
  readonly allowUnknown?: boolean;
  readonly allowDeclined?: boolean;
};

export type DemographicPolicy = { readonly fields: readonly FieldRule[] };

/** A submitted field: a concrete value, or an explicit absence marker (not both). */
export type FieldEntry = { value?: string | null; marker?: Marker };
export type DemographicInput = Readonly<Record<string, FieldEntry>>;

export type FieldIssue = { field: string; reason: string };
export type DemographicValidation = { ok: boolean; issues: FieldIssue[] };

export class DemographicError extends Error {}

function hasValue(e: FieldEntry | undefined): boolean {
  return e !== undefined && e.value !== undefined && e.value !== null && String(e.value).trim() !== '';
}

/**
 * Validate a demographic submission against the policy. Returns every issue
 * (never throws on validation failure) so the UI can flag all fields at once.
 */
export function validateDemographics(policy: DemographicPolicy, input: DemographicInput): DemographicValidation {
  const issues: FieldIssue[] = [];
  for (const rule of policy.fields) {
    const entry = input[rule.field];
    const marked = entry?.marker;

    if (marked !== undefined && hasValue(entry)) {
      issues.push({ field: rule.field, reason: 'a field cannot carry both a value and an unknown/declined marker' });
      continue;
    }
    if (marked !== undefined) {
      if (marked === 'unknown' && rule.allowUnknown !== true) issues.push({ field: rule.field, reason: 'unknown is not permitted for this field' });
      if (marked === 'declined' && rule.allowDeclined !== true) issues.push({ field: rule.field, reason: 'declined is not permitted for this field' });
      continue; // a permitted marker satisfies the field
    }
    if (hasValue(entry)) continue; // a concrete value satisfies the field
    if (rule.required) {
      const allowed = [rule.allowUnknown ? 'unknown' : null, rule.allowDeclined ? 'declined' : null].filter(Boolean);
      const hint = allowed.length ? ` (or mark ${allowed.join('/')})` : '';
      issues.push({ field: rule.field, reason: `${rule.field} is required${hint}` });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Throwing variant for the write path. */
export function assertDemographics(policy: DemographicPolicy, input: DemographicInput): void {
  const r = validateDemographics(policy, input);
  if (!r.ok) throw new DemographicError(r.issues.map((i) => `${i.field}: ${i.reason}`).join('; '));
}
