/**
 * Patient identity on D1 (PAT-001/002/003): list/search, and registration with a
 * probabilistic duplicate check. The matcher is the SAME framework-neutral domain
 * function (`findDuplicates`) the edge used — registration refuses to silently
 * create a likely duplicate; the caller reviews candidates and re-submits with
 * `force`. Every creation is audited. Ported from the Postgres edge `patients.ts`.
 *
 * (The full PAT-004 demographic-capture policy engine is not wired here — the UI
 * already requires given+family names; registration checks those and the matcher.)
 */
import { uuidv7, findDuplicates, type PatientCandidate } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

export type PatientRow = { id: string; mrn: string; given_name: string; family_name: string; dob: string | null; sex: string | null };

/** List or search patients. With `q` (>=2 chars) filters on MRN / given / family. */
export async function listPatients(db: D1Database, q?: string, limit = 200): Promise<PatientRow[]> {
  const term = (q ?? '').trim();
  if (term.length >= 2) {
    const like = `%${term}%`;
    return many<PatientRow>(
      db,
      `SELECT id, mrn, given_name, family_name, date_of_birth AS dob, sex
       FROM identity_patient
       WHERE deceased = 0 AND (mrn LIKE ? OR given_name LIKE ? OR family_name LIKE ?)
       ORDER BY family_name, given_name LIMIT ?`,
      [like, like, like, limit],
    );
  }
  return many<PatientRow>(
    db,
    `SELECT id, mrn, given_name, family_name, date_of_birth AS dob, sex
     FROM identity_patient WHERE deceased = 0 ORDER BY family_name, given_name LIMIT ?`,
    [limit],
  );
}

export type RegisterBody = { givenName?: string; familyName?: string; dateOfBirth?: string; sex?: string; force?: boolean; user?: string; site?: string };
export type RegisterResult =
  | { ok: true; id: string; mrn: string }
  | { ok: false; duplicates: ReadonlyArray<{ candidate: PatientCandidate; score: number; reasons: readonly string[] }> };

async function loadCandidates(db: D1Database): Promise<PatientCandidate[]> {
  const rows = await many<{ id: string; given_name: string | null; family_name: string | null; dob: string | null; sex: string | null }>(
    db,
    `SELECT id, given_name, family_name, date_of_birth AS dob, sex FROM identity_patient WHERE deceased = 0`,
  );
  return rows.map((r) => ({
    id: r.id,
    givenName: r.given_name ?? '',
    familyName: r.family_name ?? '',
    ...(r.dob ? { dateOfBirth: r.dob } : {}),
    ...(r.sex ? { sex: r.sex } : {}),
  }));
}

/** Next MRN in the SCC-###### series (max existing + 1). */
async function nextMrn(db: D1Database): Promise<string> {
  const r = await one<{ n: number }>(
    db,
    `SELECT COALESCE(MAX(CAST(substr(mrn,5) AS INTEGER)),0) AS n FROM identity_patient WHERE mrn LIKE 'SCC-%'`,
  );
  const next = Number(r?.n ?? 0) + 1;
  return 'SCC-' + String(next).padStart(6, '0');
}

/** Register a patient unless a likely duplicate is found (and not forced). Audited. */
export async function registerPatient(db: D1Database, body: RegisterBody, threshold = 0.7): Promise<RegisterResult> {
  if (!body.givenName?.trim() || !body.familyName?.trim()) {
    throw new Error('given and family names are required');
  }
  const candidates = await loadCandidates(db);
  const incoming: Omit<PatientCandidate, 'id'> = {
    givenName: body.givenName ?? '',
    familyName: body.familyName ?? '',
    ...(body.dateOfBirth ? { dateOfBirth: body.dateOfBirth } : {}),
    ...(body.sex ? { sex: body.sex } : {}),
  };
  const duplicates = findDuplicates(incoming, candidates, threshold);
  if (duplicates.length > 0 && !body.force) {
    return { ok: false, duplicates };
  }
  const id = uuidv7();
  const mrn = await nextMrn(db);
  await db.batch([
    stmt(db, `INSERT INTO identity_patient (id, mrn, given_name, family_name, date_of_birth, sex, site_id) VALUES (?,?,?,?,?,?,?)`,
      [id, mrn, body.givenName ?? null, body.familyName ?? null, body.dateOfBirth ?? null, body.sex ?? null, body.site ?? null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash)
              VALUES (?,?,'create','patient',?,?,'success',?,?)`,
      [uuidv7(), body.user ?? null, id, id, body.force ? 'created despite duplicate review' : 'new registration', 'patient:' + id]),
  ]);
  return { ok: true, id, mrn };
}
