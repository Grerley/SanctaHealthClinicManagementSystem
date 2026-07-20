/**
 * Patient identity: registration with a duplicate check, and search (PAT-001/002/
 * 003/004, pack §6.1). Registration runs the shared probabilistic matcher against
 * locally available records and refuses to silently create a likely duplicate —
 * the caller must review candidates and confirm (force) to proceed. Never merges
 * automatically. Every creation is audited (BR-012).
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7, findDuplicates, type PatientCandidate, type MatchResult } from '@sancta/domain';

export type RegisterBody = {
  givenName: string;
  familyName: string;
  dateOfBirth?: string; // ISO date
  sex?: string;
  phone?: string;
  /** Proceed despite likely duplicates (after human review). */
  force?: boolean;
  user?: string;
  site?: string;
};

export type RegisterResult =
  | { ok: true; id: string; mrn: string }
  | { ok: false; duplicates: readonly MatchResult[] };

async function loadCandidates(client: PoolClient | Pool): Promise<PatientCandidate[]> {
  const res = await client.query(
    `SELECT id, given_name, family_name, to_char(date_of_birth,'YYYY-MM-DD') AS dob, sex, phone FROM identity.patient`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    givenName: r.given_name ?? '',
    familyName: r.family_name ?? '',
    ...(r.dob ? { dateOfBirth: r.dob } : {}),
    ...(r.sex ? { sex: r.sex } : {}),
    ...(r.phone ? { phone: r.phone } : {}),
  }));
}

export async function registerPatient(pool: Pool, body: RegisterBody, threshold = 0.7): Promise<RegisterResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await loadCandidates(client);
    const incoming: Omit<PatientCandidate, 'id'> = {
      givenName: body.givenName,
      familyName: body.familyName,
      ...(body.dateOfBirth ? { dateOfBirth: body.dateOfBirth } : {}),
      ...(body.sex ? { sex: body.sex } : {}),
      ...(body.phone ? { phone: body.phone } : {}),
    };
    const duplicates = findDuplicates(incoming, candidates, threshold);
    if (duplicates.length > 0 && !body.force) {
      await client.query('ROLLBACK');
      return { ok: false, duplicates };
    }

    const id = uuidv7();
    const mrnRes = await client.query(`SELECT 'SCC-' || lpad(nextval('identity.mrn_seq')::text, 6, '0') AS mrn`);
    const mrn = mrnRes.rows[0].mrn as string;
    await client.query(
      `INSERT INTO identity.patient (id, mrn, given_name, family_name, date_of_birth, sex, phone, site_id, created_by, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`,
      [id, mrn, body.givenName, body.familyName, body.dateOfBirth ?? null, body.sex ?? null, body.phone ?? null, body.site ?? null, body.user ?? null],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','patient',$3,$3,'success',$4, now(), $5)`,
      [uuidv7(), body.user ?? null, id, body.force ? 'created despite duplicate review' : 'new registration', 'patient:' + id],
    );
    await client.query('COMMIT');
    return { ok: true, id, mrn };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type PatientSearchRow = {
  id: string;
  mrn: string;
  given_name: string;
  family_name: string;
  dob: string | null;
  sex: string | null;
};

/** Search by MRN, name or phone. Returns minimum identity discriminators (PAT-002). */
export async function searchPatients(pool: Pool, q: string, limit = 20): Promise<PatientSearchRow[]> {
  const term = `%${q.trim()}%`;
  const res = await pool.query(
    `SELECT id, mrn, given_name, family_name, to_char(date_of_birth,'DD/MM/YYYY') AS dob, sex
     FROM identity.patient
     WHERE merged_into IS NULL AND (mrn ILIKE $1 OR given_name ILIKE $1 OR family_name ILIKE $1 OR phone ILIKE $1)
     ORDER BY family_name, given_name
     LIMIT $2`,
    [term, limit],
  );
  return res.rows as PatientSearchRow[];
}
