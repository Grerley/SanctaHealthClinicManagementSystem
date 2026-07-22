/**
 * Chronological patient clinical timeline on D1 (EHR-002, §7.3). Assembles the
 * patient's clinical events — encounters, addenda, observations (vitals) and
 * results — into one time-ordered view, each carrying its provenance (who and
 * when, plus source type). Supports filtering by event type and date window.
 * Read-only; every item is derived from the source records, none is editable here.
 * Ported from the Postgres edge `timeline.ts`.
 *
 * D1 translations: to_char(...) → stored ISO text (COALESCE for the encounter's
 * effective time); boolean critical → INTEGER 0/1; merge/sort in JS.
 */
import type { D1Database } from './d1.ts';
import { many } from './query.ts';

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

export async function patientTimeline(db: D1Database, patientId: string, q: TimelineQuery = {}): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];
  const want = (t: TimelineItem['type']) => q.type === undefined || q.type === t;

  if (want('encounter')) {
    const rows = await many<{ id: string; status: string; form_code: string | null; signed_by: string | null; at: string }>(db,
      `SELECT id, status, form_code, signed_by, COALESCE(signed_at, created_at) AS at FROM clinical_encounter WHERE patient_id=?`, [patientId]);
    for (const x of rows) items.push({ type: 'encounter', id: x.id, at: x.at, summary: x.form_code ? `Encounter (${x.form_code})` : 'Encounter', author: x.signed_by, status: x.status });
  }
  if (want('addendum')) {
    const rows = await many<{ id: string; author: string; at: string }>(db,
      `SELECT a.id, a.author, a.created_at AS at FROM clinical_encounter_addendum a JOIN clinical_encounter e ON e.id=a.encounter_id WHERE e.patient_id=?`, [patientId]);
    for (const x of rows) items.push({ type: 'addendum', id: x.id, at: x.at, summary: 'Addendum', author: x.author });
  }
  if (want('observation')) {
    const rows = await many<{ id: string; kind: string; value: number; unit: string | null; flag: string; recorded_by: string | null; at: string }>(db,
      `SELECT id, kind, value, unit, flag, recorded_by, recorded_at AS at FROM clinical_observation WHERE patient_id=?`, [patientId]);
    for (const x of rows) items.push({ type: 'observation', id: x.id, at: x.at, summary: `${x.kind} ${x.value}${x.unit ?? ''}`, author: x.recorded_by, flags: x.flag === 'ok' ? [] : [x.flag] });
  }
  if (want('result')) {
    const rows = await many<{ id: string; value: number; unit: string | null; abnormal: string; critical: number; verified_by: string | null; at: string }>(db,
      `SELECT id, value, unit, abnormal, critical, verified_by, released_at AS at FROM clinical_result WHERE patient_id=?`, [patientId]);
    for (const x of rows) items.push({ type: 'result', id: x.id, at: x.at, summary: `Result ${x.value}${x.unit ?? ''}`, author: x.verified_by, flags: [x.abnormal, ...(x.critical ? ['critical'] : [])].filter((f) => f && f !== 'normal') });
  }

  const from = q.from;
  const to = q.to;
  return items
    .filter((i) => (from === undefined || i.at >= from) && (to === undefined || i.at <= to))
    .sort((a, b) => (a.at === b.at ? a.type.localeCompare(b.type) : a.at.localeCompare(b.at)));
}
