/**
 * Appointment scheduling on D1 (APT-001/008): create a bookable slot and the
 * calendar feed the Calendar screen renders (day/week, grouped by provider/room/
 * service). Ported from the Postgres edge `scheduling.ts`.
 *
 * Times are ISO-8601 UTC text, so the day is `substr(starts_at,1,10)` and the
 * date-window filter is a plain string range (ISO sorts chronologically).
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { many } from './query.ts';

export type CalendarEntry = {
  slotId: string;
  provider: string;
  room: string | null;
  serviceCode: string | null;
  startsAt: string;
  endsAt: string;
  day: string;
  status: string;
  patientMrn: string | null;
};

/** Create an open slot. */
export async function createSlot(
  db: D1Database,
  args: { provider: string; site?: string; startsAt: string; endsAt: string; room?: string; serviceCode?: string },
): Promise<{ slotId: string }> {
  const slotId = uuidv7();
  await db.prepare(
    `INSERT INTO scheduling_slot (id, provider, site_id, starts_at, ends_at, status, room, service_code) VALUES (?,?,?,?,?,'open',?,?)`,
  ).bind(slotId, args.provider, args.site ?? null, args.startsAt, args.endsAt, args.room ?? null, args.serviceCode ?? null).run();
  return { slotId };
}

/** Every slot (with any active booking) in [from, to] inclusive, ordered by time. */
export async function calendarView(db: D1Database, args: { from: string; to: string }): Promise<CalendarEntry[]> {
  const rows = await many<{
    id: string; provider: string; room: string | null; service_code: string | null;
    starts_at: string; ends_at: string; status: string; patient_mrn: string | null;
  }>(
    db,
    `SELECT s.id, s.provider, s.room, s.service_code, s.starts_at, s.ends_at, s.status, p.mrn AS patient_mrn
     FROM scheduling_slot s
     LEFT JOIN scheduling_appointment a ON a.slot_id = s.id AND a.status NOT IN ('cancelled','no_show','left_before_seen')
     LEFT JOIN identity_patient p ON p.id = a.patient_id
     WHERE substr(s.starts_at,1,10) >= ? AND substr(s.starts_at,1,10) <= ?
     ORDER BY s.starts_at, s.provider`,
    [args.from, args.to],
  );
  return rows.map((x) => ({
    slotId: x.id,
    provider: x.provider,
    room: x.room,
    serviceCode: x.service_code,
    startsAt: x.starts_at,
    endsAt: x.ends_at,
    day: x.starts_at.slice(0, 10),
    status: x.status,
    patientMrn: x.patient_mrn,
  }));
}
