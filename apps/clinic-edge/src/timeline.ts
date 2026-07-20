/**
 * Chronological patient clinical timeline (EHR-002, pack §7.3). Assembles the
 * patient's clinical events — encounters, addenda, observations (vitals) and
 * results — into one time-ordered view, each carrying its provenance (who and
 * when, plus source type). Supports filtering by event type and date window.
 * Read-only; every item is derived from the source records, none is editable here.
 */
import type { Pool } from 'pg';

export type TimelineItem = {
  type: 'encounter' | 'addendum' | 'observation' | 'result';
  id: string;
  at: string; // ISO timestamp
  summary: string;
  author: string | null; // provenance: who recorded/signed
  status?: string;
  flags?: string[];
};

export type TimelineQuery = { type?: TimelineItem['type']; from?: string; to?: string };

export async function patientTimeline(pool: Pool, patientId: string, q: TimelineQuery = {}): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];
  const want = (t: TimelineItem['type']) => q.type === undefined || q.type === t;

  if (want('encounter')) {
    const r = await pool.query(
      `SELECT id, status, form_code, signed_by, created_at,
              to_char(coalesce(signed_at, created_at),'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
       FROM clinical.encounter WHERE patient_id=$1`,
      [patientId],
    );
    for (const x of r.rows) items.push({ type: 'encounter', id: x.id, at: x.at, summary: x.form_code ? `Encounter (${x.form_code})` : 'Encounter', author: x.signed_by, status: x.status });
  }
  if (want('addendum')) {
    const r = await pool.query(
      `SELECT a.id, a.author, to_char(a.created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
       FROM clinical.encounter_addendum a JOIN clinical.encounter e ON e.id=a.encounter_id
       WHERE e.patient_id=$1`,
      [patientId],
    );
    for (const x of r.rows) items.push({ type: 'addendum', id: x.id, at: x.at, summary: 'Addendum', author: x.author });
  }
  if (want('observation')) {
    const r = await pool.query(
      `SELECT id, kind, value, unit, flag, recorded_by, to_char(recorded_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
       FROM clinical.observation WHERE patient_id=$1`,
      [patientId],
    );
    for (const x of r.rows) items.push({ type: 'observation', id: x.id, at: x.at, summary: `${x.kind} ${x.value}${x.unit ?? ''}`, author: x.recorded_by, flags: x.flag === 'ok' ? [] : [x.flag] });
  }
  if (want('result')) {
    const r = await pool.query(
      `SELECT id, value, unit, abnormal, critical, verified_by, to_char(released_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
       FROM clinical.result WHERE patient_id=$1`,
      [patientId],
    );
    for (const x of r.rows) items.push({ type: 'result', id: x.id, at: x.at, summary: `Result ${x.value}${x.unit ?? ''}`, author: x.verified_by, flags: [x.abnormal, ...(x.critical ? ['critical'] : [])].filter((f) => f && f !== 'normal') });
  }

  const from = q.from;
  const to = q.to;
  return items
    .filter((i) => (from === undefined || i.at >= from) && (to === undefined || i.at <= to))
    .sort((a, b) => (a.at === b.at ? a.type.localeCompare(b.type) : a.at.localeCompare(b.at)));
}
