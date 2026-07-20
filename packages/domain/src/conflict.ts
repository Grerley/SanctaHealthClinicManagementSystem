/**
 * Field-level 3-way merge for offline sync conflicts (SYN-006, pack §15.5).
 *
 * When the same entity is edited on more than one site while offline, the naive
 * "last write wins" would silently destroy a clinician's or cashier's work. The
 * pack forbids that for patient identity, signed clinical content, stock and
 * finance. Instead we merge at the FIELD level against a common ancestor (`base`):
 *
 *   - incoming field == current field          → nothing to do (already agree)
 *   - current field == base field              → central side never touched it;
 *                                                 the incoming change is a safe,
 *                                                 one-sided merge → apply it
 *   - both sides moved it away from base        → genuine conflict → preserve BOTH
 *                                                 values and queue a human decision
 *
 * This never invents a value and never picks a winner for a contended field; the
 * unsafe case becomes a `ConflictCase` for a person to resolve. Identity fields
 * (name, DOB, sex) are flagged so the queue can prioritise them (PAT-004).
 */

export type FieldValue = string | number | boolean | null;
export type Record3 = Readonly<Record<string, FieldValue>>;

/** Demographic fields that establish patient identity — never auto-resolved silently. */
export const DEMOGRAPHIC_IDENTITY_FIELDS = ['given_name', 'family_name', 'date_of_birth', 'sex'] as const;

export type FieldConflict = {
  field: string;
  base: FieldValue;
  current: FieldValue;
  incoming: FieldValue;
  /** True when the field participates in identity (raises the stakes of a wrong merge). */
  identity: boolean;
};

export type MergeResult = {
  /** Fields safe to apply to the current record (one-sided changes). */
  applied: Record<string, FieldValue>;
  /** Fields both sides changed differently — preserved for human resolution. */
  conflicts: FieldConflict[];
};

export class ConflictError extends Error {}

function eq(a: FieldValue, b: FieldValue): boolean {
  return a === b;
}

/**
 * Three-way merge of `incoming` onto `current`, relative to their common ancestor
 * `base`. Only fields present in `incoming` are considered (a partial patch is
 * fine). `identityFields` marks which fields count as identity for prioritisation.
 */
export function mergeFields(
  base: Record3,
  current: Record3,
  incoming: Record3,
  identityFields: readonly string[] = DEMOGRAPHIC_IDENTITY_FIELDS,
): MergeResult {
  const applied: Record<string, FieldValue> = {};
  const conflicts: FieldConflict[] = [];
  const identity = new Set(identityFields);

  for (const field of Object.keys(incoming)) {
    const inc = incoming[field] as FieldValue;
    const cur = (field in current ? current[field] : null) as FieldValue;
    const bas = (field in base ? base[field] : null) as FieldValue;

    if (eq(inc, cur)) continue; // already agree — nothing to do
    if (eq(inc, bas)) continue; // incoming never changed this field → keep current
    if (eq(cur, bas)) {
      applied[field] = inc; // central side untouched → safe one-sided merge
      continue;
    }
    // both sides diverged from the ancestor → genuine conflict
    conflicts.push({ field, base: bas, current: cur, incoming: inc, identity: identity.has(field) });
  }

  return { applied, conflicts };
}

/** Convenience wrapper for patient demographics. */
export function mergeDemographics(base: Record3, current: Record3, incoming: Record3): MergeResult {
  return mergeFields(base, current, incoming, DEMOGRAPHIC_IDENTITY_FIELDS);
}

export type ConflictResolution = 'accept_incoming' | 'keep_current' | 'manual';

/**
 * Apply a human decision to a single field conflict, returning the chosen value.
 * `manual` requires an explicit value (the resolver typed a corrected value).
 */
export function resolveField(conflict: FieldConflict, decision: ConflictResolution, manualValue?: FieldValue): FieldValue {
  switch (decision) {
    case 'accept_incoming':
      return conflict.incoming;
    case 'keep_current':
      return conflict.current;
    case 'manual':
      if (manualValue === undefined) throw new ConflictError(`manual resolution of "${conflict.field}" requires a value`);
      return manualValue;
    default:
      throw new ConflictError(`unknown resolution ${String(decision)}`);
  }
}
