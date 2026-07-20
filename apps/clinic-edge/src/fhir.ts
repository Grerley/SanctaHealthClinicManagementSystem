/**
 * FHIR-compatible read endpoints (SYN-009). Read-only projections of edge records
 * onto FHIR R4 resources; the edge PostgreSQL remains the system of record.
 */
import type { Pool } from 'pg';
import { toFhirPatient, type FhirPatient, type InternalPatient } from '@sancta/domain';

function rowToInternal(r: {
  id: string;
  mrn: string | null;
  given_name: string | null;
  family_name: string | null;
  sex: string | null;
  dob: string | null;
  phone: string | null;
  deceased: boolean;
  deceased_at: string | null;
}): InternalPatient {
  return { id: r.id, mrn: r.mrn, givenName: r.given_name, familyName: r.family_name, sex: r.sex, dateOfBirth: r.dob, phone: r.phone, deceased: r.deceased, deceasedAt: r.deceased_at };
}

const SELECT = `SELECT id, mrn, given_name, family_name, sex, to_char(date_of_birth,'YYYY-MM-DD') AS dob, phone, deceased, to_char(deceased_at,'YYYY-MM-DD') AS deceased_at FROM identity.patient`;

/** Read a single patient as a FHIR Patient. Returns null if not found. */
export async function fhirPatientById(pool: Pool, id: string): Promise<FhirPatient | null> {
  const r = await pool.query(`${SELECT} WHERE id=$1`, [id]);
  if (r.rowCount === 0) return null;
  return toFhirPatient(rowToInternal(r.rows[0]));
}

/** Search patients by MRN identifier, returning FHIR Patient resources. */
export async function fhirPatientSearch(pool: Pool, identifier: string): Promise<FhirPatient[]> {
  const r = await pool.query(`${SELECT} WHERE mrn ILIKE $1 AND merged_into IS NULL ORDER BY family_name, given_name LIMIT 50`, [`%${identifier}%`]);
  return r.rows.map((x) => toFhirPatient(rowToInternal(x)));
}
