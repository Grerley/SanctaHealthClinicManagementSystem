/**
 * Clinical history, coded diagnoses & draft recovery on D1 (EHR-004/005/007, §7).
 *
 * EHR-004: structured, status-tracked history (problems, past/surgical/family/
 * social, immunisations, allergies).
 * EHR-005: coded diagnoses with certainty + rank + free-text, over an offline-
 * searchable code table.
 * EHR-007: a patient's open draft encounter is reused, never duplicated, so an
 * interrupted form recovers to the same encounter on reconnect.
 *
 * Ported from the Postgres edge `ehr.ts`. D1 translations: ILIKE → LIKE (ASCII
 * case-insensitive); RETURNING → run() rowcount + JS-stamped time; interactive tx
 * → read-then-batch (the open-draft reuse read is the no-duplicate gate).
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

export class EhrError extends Error {}

const HISTORY_CATEGORIES = ['problem', 'past_medical', 'surgical', 'family', 'social', 'immunisation', 'allergy'] as const;
const CERTAINTY = ['suspected', 'provisional', 'confirmed'] as const;
const DEFAULT_SITE = '00000000-0000-7000-8000-0000000000f1';

function nowIso(): string { return new Date().toISOString().slice(0, 19) + 'Z'; }

// --- EHR-004 clinical history ----------------------------------------------

export async function addHistoryItem(
  db: D1Database,
  args: { patientId: string; category: string; detail: string; code?: string; onsetDate?: string; user?: string },
): Promise<{ id: string }> {
  if (!(HISTORY_CATEGORIES as readonly string[]).includes(args.category)) throw new EhrError(`category must be one of ${HISTORY_CATEGORIES.join(', ')}`);
  if (!args.detail?.trim()) throw new EhrError('detail is required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO clinical_history_item (id, patient_id, category, detail, code, onset_date, recorded_by) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, args.patientId, args.category, args.detail, args.code ?? null, args.onsetDate ?? null, args.user ?? null).run();
  return { id };
}

export async function setHistoryStatus(db: D1Database, args: { id: string; status: string }): Promise<{ id: string; status: string }> {
  if (!['active', 'resolved', 'inactive'].includes(args.status)) throw new EhrError('status must be active|resolved|inactive');
  const changed = await run(db, `UPDATE clinical_history_item SET status=? WHERE id=?`, [args.status, args.id]);
  if (changed === 0) throw new EhrError('history item not found');
  return { id: args.id, status: args.status };
}

export async function listHistory(db: D1Database, patientId: string, category?: string): Promise<Array<{ id: string; category: string; detail: string; code: string | null; status: string; onsetDate: string | null }>> {
  const rows = category
    ? await many<{ id: string; category: string; detail: string; code: string | null; status: string; onset: string | null }>(db, `SELECT id, category, detail, code, status, onset_date AS onset FROM clinical_history_item WHERE patient_id=? AND category=? ORDER BY recorded_at DESC`, [patientId, category])
    : await many<{ id: string; category: string; detail: string; code: string | null; status: string; onset: string | null }>(db, `SELECT id, category, detail, code, status, onset_date AS onset FROM clinical_history_item WHERE patient_id=? ORDER BY category, recorded_at DESC`, [patientId]);
  return rows.map((x) => ({ id: x.id, category: x.category, detail: x.detail, code: x.code, status: x.status, onsetDate: x.onset }));
}

// --- EHR-005 coded diagnoses -----------------------------------------------

/** Offline diagnosis-code search over the local code table (EHR-005). */
export async function searchDiagnosisCodes(db: D1Database, q: string, limit = 20): Promise<Array<{ system: string; code: string; display: string }>> {
  const term = `%${q.trim()}%`;
  return many<{ system: string; code: string; display: string }>(db,
    `SELECT system, code, display FROM clinical_diagnosis_code WHERE code LIKE ? OR display LIKE ? ORDER BY code LIMIT ?`, [term, term, limit]);
}

export async function recordDiagnosis(
  db: D1Database,
  args: { encounterId: string; codeSystem?: string; code?: string; freeText?: string; certainty?: string; rank?: number; user?: string },
): Promise<{ id: string; display: string | null }> {
  if (args.certainty && !(CERTAINTY as readonly string[]).includes(args.certainty)) throw new EhrError(`certainty must be one of ${CERTAINTY.join(', ')}`);
  if (!args.code && !args.freeText?.trim()) throw new EhrError('a diagnosis needs a code or free text');
  const enc = await one<{ patient_id: string }>(db, `SELECT patient_id FROM clinical_encounter WHERE id=?`, [args.encounterId]);
  if (!enc) throw new EhrError('encounter not found');

  let display: string | null = args.freeText ?? null;
  if (args.code) {
    const c = await one<{ display: string }>(db, `SELECT display FROM clinical_diagnosis_code WHERE system=? AND code=?`, [args.codeSystem ?? 'SYNTHETIC-DX', args.code]);
    if (!c) throw new EhrError(`unknown diagnosis code ${args.codeSystem ?? 'SYNTHETIC-DX'}:${args.code}`);
    display = c.display;
  }
  const id = uuidv7();
  await db.prepare(`INSERT INTO clinical_diagnosis (id, encounter_id, patient_id, code_system, code, display, free_text, certainty, rank, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, args.encounterId, enc.patient_id, args.code ? (args.codeSystem ?? 'SYNTHETIC-DX') : null, args.code ?? null, display, args.freeText ?? null, args.certainty ?? 'confirmed', args.rank ?? 1, args.user ?? null).run();
  return { id, display };
}

export async function listDiagnoses(db: D1Database, encounterId: string): Promise<Array<{ code: string | null; display: string | null; certainty: string; rank: number }>> {
  return many<{ code: string | null; display: string | null; certainty: string; rank: number }>(db, `SELECT code, display, certainty, rank FROM clinical_diagnosis WHERE encounter_id=? ORDER BY rank`, [encounterId]);
}

// --- EHR-007 draft recovery (no duplicate encounter) -----------------------

/**
 * Return the patient's OPEN draft encounter, creating one only if none exists. A
 * reconnecting client that lost its form recovers the same encounter instead of
 * creating a duplicate (EHR-007).
 */
export async function openDraftEncounter(db: D1Database, args: { patientId: string; user?: string }): Promise<{ encounterId: string; visitId: string; recovered: boolean; content: unknown }> {
  const existing = await one<{ id: string; visit_id: string; content: string }>(db,
    `SELECT id, visit_id, content FROM clinical_encounter WHERE patient_id=? AND status='draft' ORDER BY created_at DESC LIMIT 1`, [args.patientId]);
  if (existing) {
    return { encounterId: existing.id, visitId: existing.visit_id, recovered: true, content: JSON.parse(existing.content || '{}') };
  }
  const visitId = uuidv7();
  const encounterId = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO flow_visit (id, patient_id, visit_number, site_id, status) VALUES (?,?,?,?,'in_care')`, [visitId, args.patientId, 'V-' + visitId.slice(-12), DEFAULT_SITE]),
    stmt(db, `INSERT INTO clinical_encounter (id, visit_id, patient_id, status, form_version, content) VALUES (?,?,?,'draft',1,'{}')`, [encounterId, visitId, args.patientId]),
  ]);
  return { encounterId, visitId, recovered: false, content: {} };
}

/** Auto-save draft content. Rejected once the encounter is signed (EHR-007/BR-003). */
export async function autosaveDraft(db: D1Database, args: { encounterId: string; content: unknown }): Promise<{ savedAt: string }> {
  const changed = await run(db, `UPDATE clinical_encounter SET content=? WHERE id=? AND status='draft'`, [JSON.stringify(args.content), args.encounterId]);
  if (changed === 0) throw new EhrError('no open draft to save (encounter missing or already signed)');
  return { savedAt: nowIso() };
}
