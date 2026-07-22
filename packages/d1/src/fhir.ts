/**
 * FHIR-compatible read endpoints on D1 (SYN-009). Read-only projections of D1
 * records onto FHIR R4 resources; D1 remains the system of record. Ported from the
 * Postgres edge `fhir.ts`.
 *
 * D1 translations: to_char → stored ISO text; ILIKE → LIKE; boolean deceased →
 * INTEGER 0/1; merged patients are excluded from search.
 */
import { toFhirPatient, type FhirPatient, type InternalPatient } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many } from './query.ts';

type PatientRow = { id: string; mrn: string | null; given_name: string | null; family_name: string | null; sex: string | null; dob: string | null; phone: string | null; deceased: number; deceased_at: string | null };

function rowToInternal(r: PatientRow): InternalPatient {
  return { id: r.id, mrn: r.mrn, givenName: r.given_name, familyName: r.family_name, sex: r.sex, dateOfBirth: r.dob, phone: r.phone, deceased: Boolean(r.deceased), deceasedAt: r.deceased_at };
}

const SELECT = `SELECT id, mrn, given_name, family_name, sex, date_of_birth AS dob, phone, deceased, deceased_at FROM identity_patient`;

/** Read a single patient as a FHIR Patient. Returns null if not found. */
export async function fhirPatientById(db: D1Database, id: string): Promise<FhirPatient | null> {
  const r = await one<PatientRow>(db, `${SELECT} WHERE id=?`, [id]);
  return r ? toFhirPatient(rowToInternal(r)) : null;
}

/** Search patients by MRN identifier, returning FHIR Patient resources. */
export async function fhirPatientSearch(db: D1Database, identifier: string): Promise<FhirPatient[]> {
  const rows = await many<PatientRow>(db, `${SELECT} WHERE mrn LIKE ? AND merged_into IS NULL ORDER BY family_name, given_name LIMIT 50`, [`%${identifier}%`]);
  return rows.map((x) => toFhirPatient(rowToInternal(x)));
}
