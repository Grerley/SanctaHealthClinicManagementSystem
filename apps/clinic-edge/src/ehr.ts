/**
 * Clinical history, coded diagnoses & draft recovery (EHR-004/005/007, pack §7).
 *
 * EHR-004: structured, status-tracked history (problems, past/surgical/family/
 * social, immunisations, allergies).
 * EHR-005: coded diagnoses with certainty + rank + free-text, over an offline-
 * searchable code table (the approved system/version is decision B5).
 * EHR-007: a patient's open draft encounter is reused, never duplicated, so an
 * interrupted form recovers to the same encounter on reconnect.
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';

export class EhrError extends Error {}

const HISTORY_CATEGORIES = ['problem', 'past_medical', 'surgical', 'family', 'social', 'immunisation', 'allergy'] as const;
const CERTAINTY = ['suspected', 'provisional', 'confirmed'] as const;
const DEFAULT_SITE = '00000000-0000-7000-8000-0000000000f1';

// --- EHR-004 clinical history ----------------------------------------------

export async function addHistoryItem(
  pool: Pool,
  args: { patientId: string; category: string; detail: string; code?: string; onsetDate?: string; user?: string },
): Promise<{ id: string }> {
  if (!(HISTORY_CATEGORIES as readonly string[]).includes(args.category)) throw new EhrError(`category must be one of ${HISTORY_CATEGORIES.join(', ')}`);
  if (!args.detail?.trim()) throw new EhrError('detail is required');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO clinical.history_item (id, patient_id, category, detail, code, onset_date, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, args.patientId, args.category, args.detail, args.code ?? null, args.onsetDate ?? null, args.user ?? null],
  );
  return { id };
}

export async function setHistoryStatus(pool: Pool, args: { id: string; status: string }): Promise<{ id: string; status: string }> {
  if (!['active', 'resolved', 'inactive'].includes(args.status)) throw new EhrError('status must be active|resolved|inactive');
  const r = await pool.query(`UPDATE clinical.history_item SET status=$2 WHERE id=$1 RETURNING id`, [args.id, args.status]);
  if (r.rowCount === 0) throw new EhrError('history item not found');
  return { id: args.id, status: args.status };
}

export async function listHistory(pool: Pool, patientId: string, category?: string): Promise<Array<{ id: string; category: string; detail: string; code: string | null; status: string; onsetDate: string | null }>> {
  const r = category
    ? await pool.query(`SELECT id, category, detail, code, status, to_char(onset_date,'YYYY-MM-DD') AS onset FROM clinical.history_item WHERE patient_id=$1 AND category=$2 ORDER BY recorded_at DESC`, [patientId, category])
    : await pool.query(`SELECT id, category, detail, code, status, to_char(onset_date,'YYYY-MM-DD') AS onset FROM clinical.history_item WHERE patient_id=$1 ORDER BY category, recorded_at DESC`, [patientId]);
  return r.rows.map((x) => ({ id: x.id, category: x.category, detail: x.detail, code: x.code, status: x.status, onsetDate: x.onset }));
}

// --- EHR-005 coded diagnoses -----------------------------------------------

/** Offline diagnosis-code search over the local code table (EHR-005). */
export async function searchDiagnosisCodes(pool: Pool, q: string, limit = 20): Promise<Array<{ system: string; code: string; display: string }>> {
  const term = `%${q.trim()}%`;
  const r = await pool.query(
    `SELECT system, code, display FROM clinical.diagnosis_code WHERE code ILIKE $1 OR display ILIKE $1 ORDER BY code LIMIT $2`,
    [term, limit],
  );
  return r.rows;
}

export async function recordDiagnosis(
  pool: Pool,
  args: { encounterId: string; codeSystem?: string; code?: string; freeText?: string; certainty?: string; rank?: number; user?: string },
): Promise<{ id: string; display: string | null }> {
  if (args.certainty && !(CERTAINTY as readonly string[]).includes(args.certainty)) throw new EhrError(`certainty must be one of ${CERTAINTY.join(', ')}`);
  if (!args.code && !args.freeText?.trim()) throw new EhrError('a diagnosis needs a code or free text');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const enc = await client.query(`SELECT patient_id FROM clinical.encounter WHERE id=$1`, [args.encounterId]);
    if (enc.rowCount === 0) throw new EhrError('encounter not found');

    let display: string | null = args.freeText ?? null;
    if (args.code) {
      const c = await client.query(`SELECT display FROM clinical.diagnosis_code WHERE system=$1 AND code=$2`, [args.codeSystem ?? 'SYNTHETIC-DX', args.code]);
      if (c.rowCount === 0) throw new EhrError(`unknown diagnosis code ${args.codeSystem ?? 'SYNTHETIC-DX'}:${args.code}`);
      display = c.rows[0].display;
    }
    const id = uuidv7();
    await client.query(
      `INSERT INTO clinical.diagnosis (id, encounter_id, patient_id, code_system, code, display, free_text, certainty, rank, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, args.encounterId, enc.rows[0].patient_id, args.code ? (args.codeSystem ?? 'SYNTHETIC-DX') : null, args.code ?? null, display, args.freeText ?? null, args.certainty ?? 'confirmed', args.rank ?? 1, args.user ?? null],
    );
    await client.query('COMMIT');
    return { id, display };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listDiagnoses(pool: Pool, encounterId: string): Promise<Array<{ code: string | null; display: string | null; certainty: string; rank: number }>> {
  const r = await pool.query(`SELECT code, display, certainty, rank FROM clinical.diagnosis WHERE encounter_id=$1 ORDER BY rank`, [encounterId]);
  return r.rows;
}

// --- EHR-007 draft recovery (no duplicate encounter) -----------------------

/**
 * Return the patient's OPEN draft encounter, creating one only if none exists.
 * A reconnecting client that lost its form recovers the same encounter instead of
 * creating a duplicate (EHR-007).
 */
export async function openDraftEncounter(pool: Pool, args: { patientId: string; user?: string }): Promise<{ encounterId: string; visitId: string; recovered: boolean; content: unknown }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, visit_id, content FROM clinical.encounter WHERE patient_id=$1 AND status='draft' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [args.patientId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      await client.query('COMMIT');
      return { encounterId: existing.rows[0].id, visitId: existing.rows[0].visit_id, recovered: true, content: existing.rows[0].content };
    }
    const visitId = uuidv7();
    const encounterId = uuidv7();
    await client.query(`INSERT INTO flow.visit (id, patient_id, visit_number, site_id, status) VALUES ($1,$2,$3,$4,'in_care')`, [visitId, args.patientId, 'V-' + visitId.slice(-12), DEFAULT_SITE]);
    await client.query(`INSERT INTO clinical.encounter (id, visit_id, patient_id, status, form_version, content) VALUES ($1,$2,$3,'draft',1,'{}')`, [encounterId, visitId, args.patientId]);
    await client.query('COMMIT');
    return { encounterId, visitId, recovered: false, content: {} };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Auto-save draft content. Rejected once the encounter is signed (EHR-007/BR-003). */
export async function autosaveDraft(pool: Pool, args: { encounterId: string; content: unknown }): Promise<{ savedAt: string }> {
  const r = await pool.query(
    `UPDATE clinical.encounter SET content=$2 WHERE id=$1 AND status='draft' RETURNING to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`,
    [args.encounterId, JSON.stringify(args.content)],
  );
  if (r.rowCount === 0) throw new EhrError('no open draft to save (encounter missing or already signed)');
  return { savedAt: r.rows[0].at };
}
