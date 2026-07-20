/**
 * Related persons + restricted-record access (PAT-005, PAT-009, pack §6).
 *
 * PAT-005: add/list related persons (guardians, emergency contacts, household).
 * PAT-009: a record's sensitivity gates access — the domain decides, and a
 * sensitive/restricted/break-glass access is audited here so it is accountable.
 */
import type { Pool } from 'pg';
import { uuidv7, patientAccessDecision, type Sensitivity, type Role } from '@sancta/domain';

export class RelationError extends Error {}

const RELATIONSHIPS = ['mother', 'father', 'guardian', 'spouse', 'child', 'sibling', 'other'] as const;

export async function addRelatedPerson(
  pool: Pool,
  args: { patientId: string; name: string; relationship: string; isGuardian?: boolean; isEmergencyContact?: boolean; phone?: string; householdId?: string; relatedPatientId?: string; by?: string },
): Promise<{ id: string }> {
  if (!(RELATIONSHIPS as readonly string[]).includes(args.relationship)) throw new RelationError(`relationship must be one of ${RELATIONSHIPS.join(', ')}`);
  if (!args.name?.trim()) throw new RelationError('a name is required');
  const p = await pool.query(`SELECT 1 FROM identity.patient WHERE id=$1`, [args.patientId]);
  if (p.rowCount === 0) throw new RelationError('patient not found');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO identity.related_person (id, patient_id, name, relationship, is_guardian, is_emergency_contact, phone, household_id, related_patient_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, args.patientId, args.name, args.relationship, args.isGuardian ?? false, args.isEmergencyContact ?? false, args.phone ?? null, args.householdId ?? null, args.relatedPatientId ?? null, args.by ?? null],
  );
  return { id };
}

export type RelatedPerson = { id: string; name: string; relationship: string; isGuardian: boolean; isEmergencyContact: boolean; phone: string | null };

export async function listRelatedPersons(pool: Pool, patientId: string): Promise<RelatedPerson[]> {
  const r = await pool.query(
    `SELECT id, name, relationship, is_guardian, is_emergency_contact, phone FROM identity.related_person WHERE patient_id=$1 ORDER BY is_guardian DESC, is_emergency_contact DESC, created_at`,
    [patientId],
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, relationship: x.relationship, isGuardian: x.is_guardian, isEmergencyContact: x.is_emergency_contact, phone: x.phone }));
}

/** Guardians of a patient (PAT-005) — used by consent/authority checks. */
export async function guardians(pool: Pool, patientId: string): Promise<RelatedPerson[]> {
  return (await listRelatedPersons(pool, patientId)).filter((r) => r.isGuardian);
}

/**
 * Access a patient record subject to its sensitivity (PAT-009). Applies the domain
 * decision; a permitted sensitive/restricted/break-glass access is audited. Throws
 * if access is not permitted.
 */
export async function accessPatient(
  pool: Pool,
  args: { patientId: string; roles: Role[]; user: string; purpose?: string; breakGlass?: boolean; breakGlassReason?: string },
): Promise<{ allowed: true; sensitivity: Sensitivity; breakGlass: boolean }> {
  const p = await pool.query(`SELECT sensitivity FROM identity.patient WHERE id=$1`, [args.patientId]);
  if (p.rowCount === 0) throw new RelationError('patient not found');
  const sensitivity = p.rows[0].sensitivity as Sensitivity;
  const decision = patientAccessDecision(sensitivity, {
    roles: args.roles,
    ...(args.purpose ? { purpose: args.purpose } : {}),
    ...(args.breakGlass ? { breakGlass: true } : {}),
    ...(args.breakGlassReason ? { breakGlassReason: args.breakGlassReason } : {}),
  });
  if (!decision.allowed) throw new RelationError(decision.reason ?? 'access denied');
  if (decision.requiresAudit) {
    await pool.query(
      `INSERT INTO audit.audit_event (id, actor_user, actor_role, action, resource_type, resource_id, patient_ref, outcome, reason, purpose, captured_at, event_hash)
       VALUES ($1,$2,$3,$4,'patient',$5,$5,'success',$6,$7, now(), $8)`,
      [uuidv7(), args.user, args.roles[0] ?? null, decision.breakGlass ? 'break_glass' : 'view', args.patientId, decision.breakGlass ? 'break-glass: ' + (args.breakGlassReason ?? '') : `${sensitivity} record access`, args.purpose ?? null, 'access:' + args.patientId + ':' + uuidv7()],
    );
  }
  return { allowed: true, sensitivity, breakGlass: decision.breakGlass };
}
