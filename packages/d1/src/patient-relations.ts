/**
 * Related persons + restricted-record access on D1 (PAT-005/009). Add/list related
 * persons (guardians, emergency contacts); a record's sensitivity gates access —
 * the domain decides and a sensitive/restricted/break-glass access is audited so
 * it is accountable. Ported from the Postgres edge `patient-relations.ts`.
 */
import { uuidv7, patientAccessDecision, type Sensitivity, type Role } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many } from './query.ts';

export class RelationError extends Error {}

const RELATIONSHIPS = ['mother', 'father', 'guardian', 'spouse', 'child', 'sibling', 'other'] as const;

export async function addRelatedPerson(
  db: D1Database,
  args: { patientId: string; name: string; relationship: string; isGuardian?: boolean; isEmergencyContact?: boolean; phone?: string; householdId?: string; relatedPatientId?: string; by?: string },
): Promise<{ id: string }> {
  if (!(RELATIONSHIPS as readonly string[]).includes(args.relationship)) throw new RelationError(`relationship must be one of ${RELATIONSHIPS.join(', ')}`);
  if (!args.name?.trim()) throw new RelationError('a name is required');
  const p = await one(db, `SELECT 1 AS ok FROM identity_patient WHERE id=?`, [args.patientId]);
  if (!p) throw new RelationError('patient not found');
  const id = uuidv7();
  await db.prepare(`INSERT INTO identity_related_person (id, patient_id, name, relationship, is_guardian, is_emergency_contact, phone, household_id, related_patient_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, args.patientId, args.name, args.relationship, args.isGuardian ? 1 : 0, args.isEmergencyContact ? 1 : 0, args.phone ?? null, args.householdId ?? null, args.relatedPatientId ?? null, args.by ?? null).run();
  return { id };
}

export type RelatedPerson = { id: string; name: string; relationship: string; isGuardian: boolean; isEmergencyContact: boolean; phone: string | null };

export async function listRelatedPersons(db: D1Database, patientId: string): Promise<RelatedPerson[]> {
  const rows = await many<{ id: string; name: string; relationship: string; is_guardian: number; is_emergency_contact: number; phone: string | null }>(
    db, `SELECT id, name, relationship, is_guardian, is_emergency_contact, phone FROM identity_related_person WHERE patient_id=? ORDER BY is_guardian DESC, is_emergency_contact DESC, created_at`, [patientId]);
  return rows.map((x) => ({ id: x.id, name: x.name, relationship: x.relationship, isGuardian: !!x.is_guardian, isEmergencyContact: !!x.is_emergency_contact, phone: x.phone }));
}

/** Guardians of a patient (PAT-005) — used by consent/authority checks. */
export async function guardians(db: D1Database, patientId: string): Promise<RelatedPerson[]> {
  return (await listRelatedPersons(db, patientId)).filter((r) => r.isGuardian);
}

/** Access a patient record subject to its sensitivity (PAT-009). Applies the
 * domain decision; a permitted sensitive/restricted/break-glass access is audited. */
export async function accessPatient(
  db: D1Database,
  args: { patientId: string; roles: Role[]; user: string; purpose?: string; breakGlass?: boolean; breakGlassReason?: string },
): Promise<{ allowed: true; sensitivity: Sensitivity; breakGlass: boolean }> {
  const p = await one<{ sensitivity: string }>(db, `SELECT sensitivity FROM identity_patient WHERE id=?`, [args.patientId]);
  if (!p) throw new RelationError('patient not found');
  const sensitivity = p.sensitivity as Sensitivity;
  const decision = patientAccessDecision(sensitivity, {
    roles: args.roles,
    ...(args.purpose ? { purpose: args.purpose } : {}),
    ...(args.breakGlass ? { breakGlass: true } : {}),
    ...(args.breakGlassReason ? { breakGlassReason: args.breakGlassReason } : {}),
  });
  if (!decision.allowed) throw new RelationError(decision.reason ?? 'access denied');
  if (decision.requiresAudit) {
    await db.prepare(`INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash) VALUES (?,?,?,'patient',?,?,'success',?,?)`)
      .bind(uuidv7(), args.user, decision.breakGlass ? 'break_glass' : 'view', args.patientId, args.patientId,
        (decision.breakGlass ? 'break-glass: ' + (args.breakGlassReason ?? '') : `${sensitivity} record access`) + (args.purpose ? ` [purpose: ${args.purpose}]` : ''),
        'access:' + args.patientId + ':' + uuidv7()).run();
  }
  return { allowed: true, sensitivity, breakGlass: decision.breakGlass };
}
