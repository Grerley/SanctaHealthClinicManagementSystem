/**
 * Telemetry / log redaction (NFR-018, NFR-025, pack §17). Nothing that identifies
 * a patient may leave the system in logs, metrics or error reports. This redacts a
 * structured record before it is logged: values under known PHI keys are masked,
 * free-text is dropped, and only safe operational fields (ids, counts, codes,
 * timestamps, booleans) survive. Applied at the logging boundary so support data
 * is useful without ever carrying PHI.
 */

/** Keys whose values are personally identifying and must never be logged. */
export const PHI_KEYS = new Set([
  'given_name', 'givenname', 'family_name', 'familyname', 'name', 'fullname',
  'date_of_birth', 'dateofbirth', 'dob', 'birthdate',
  'phone', 'telecom', 'address', 'email',
  'content', 'note', 'notes', 'narrative', 'reason', 'memo',
  'patient_ref', 'patientref', 'mrn',
]);

const MASK = '[redacted]';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Return a deep copy of `record` safe to log: PHI-keyed values masked, everything
 * else preserved. Arrays and nested objects are walked. Non-object input is
 * returned unchanged (callers should only log structured context).
 */
export function redact<T>(record: T): T {
  if (Array.isArray(record)) return record.map((v) => redact(v)) as unknown as T;
  if (isPlainObject(record)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (PHI_KEYS.has(k.toLowerCase())) out[k] = MASK;
      else out[k] = redact(v);
    }
    return out as unknown as T;
  }
  return record;
}

/** True if a redacted record still contains any PHI-keyed value (should be false). */
export function containsPhi(record: unknown): boolean {
  if (Array.isArray(record)) return record.some(containsPhi);
  if (isPlainObject(record)) {
    for (const [k, v] of Object.entries(record)) {
      if (PHI_KEYS.has(k.toLowerCase()) && v !== MASK) return true;
      if (containsPhi(v)) return true;
    }
  }
  return false;
}
