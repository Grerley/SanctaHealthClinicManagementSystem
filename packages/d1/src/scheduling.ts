/**
 * Appointment scheduling on D1 (APT-001/008): create a bookable slot and the
 * calendar feed the Calendar screen renders (day/week, grouped by provider/room/
 * service). Ported from the Postgres edge `scheduling.ts`.
 *
 * Times are ISO-8601 UTC text, so the day is `substr(starts_at,1,10)` and the
 * date-window filter is a plain string range (ISO sorts chronologically).
 */
import {
  uuidv7, assertTransition, APPOINTMENT_TRANSITIONS, nextWaitlistCandidate, appointmentReminder,
  type AppointmentState, type WaitlistEntry, type AppointmentInfo,
} from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class SchedulingError extends Error {}
export type AppointmentType = { code: string; version: number; name: string; durationMin: number; prep: string | null; depositMinor: number };

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

// --- Appointment lifecycle (APT-001/002/003) --------------------------------

export type BookResult = { ok: true; appointmentId: string } | { ok: false; reason: 'slot_unavailable' };

/** Book a patient into a slot. Double-booking is impossible: the active-slot
 * partial UNIQUE index makes a concurrent second booking's insert fail, rolling
 * the batch back (the D1 stand-in for the Postgres FOR UPDATE slot lock). */
export async function bookAppointment(
  db: D1Database,
  args: { slotId: string; patientId: string; serviceCode?: string; reason?: string; user?: string },
): Promise<BookResult> {
  const slot = await one<{ status: string }>(db, `SELECT status FROM scheduling_slot WHERE id=?`, [args.slotId]);
  if (!slot) throw new SchedulingError('slot not found');
  if (slot.status !== 'open') return { ok: false, reason: 'slot_unavailable' };
  const appointmentId = uuidv7();
  try {
    await db.batch([
      stmt(db, `UPDATE scheduling_slot SET status='booked' WHERE id=?`, [args.slotId]),
      stmt(db, `INSERT INTO scheduling_appointment (id, slot_id, patient_id, service_code, reason, status) VALUES (?,?,?,?,?, 'booked')`,
        [appointmentId, args.slotId, args.patientId, args.serviceCode ?? null, args.reason ?? null]),
      stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, event_hash) VALUES (?,?,'create','appointment',?,?,'success',?)`,
        [uuidv7(), args.user ?? null, appointmentId, args.patientId, 'appt:' + appointmentId]),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) return { ok: false, reason: 'slot_unavailable' };
    throw e;
  }
  return { ok: true, appointmentId };
}

/** Next open slot for a provider at/after a time (APT-003). */
export async function nextAvailableSlot(db: D1Database, args: { provider: string; afterIso: string }): Promise<{ slotId: string; startsAt: string } | null> {
  const r = await one<{ id: string; starts_at: string }>(db,
    `SELECT id, starts_at FROM scheduling_slot WHERE provider=? AND status='open' AND starts_at >= ? ORDER BY starts_at ASC LIMIT 1`, [args.provider, args.afterIso]);
  return r ? { slotId: r.id, startsAt: r.starts_at } : null;
}

/** Change an appointment's status through the allowed lifecycle (APT-002/006).
 * Cancel/no-show/left releases the slot back to open. Illegal moves throw. */
export async function setAppointmentStatus(db: D1Database, args: { appointmentId: string; to: AppointmentState; user?: string }): Promise<{ status: AppointmentState }> {
  const cur = await one<{ slot_id: string; status: string }>(db, `SELECT slot_id, status FROM scheduling_appointment WHERE id=?`, [args.appointmentId]);
  if (!cur) throw new SchedulingError('appointment not found');
  assertTransition(APPOINTMENT_TRANSITIONS, cur.status as AppointmentState, args.to); // throws on illegal move
  const releases = args.to === 'cancelled' || args.to === 'no_show' || args.to === 'left_before_seen';
  const statements = [
    stmt(db, `UPDATE scheduling_appointment SET status=?, updated_at=${NOW} WHERE id=? AND status=?`, [args.to, args.appointmentId, cur.status]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'amend','appointment',?,'success',?,?)`,
      [uuidv7(), args.user ?? null, args.appointmentId, `${cur.status} -> ${args.to}`, 'appt-status:' + args.appointmentId + ':' + args.to]),
  ];
  if (releases) statements.push(stmt(db, `UPDATE scheduling_slot SET status='open' WHERE id=?`, [cur.slot_id]));
  await db.batch(statements);
  return { status: args.to };
}

// --- Waiting list (APT-004) -------------------------------------------------

export async function addToWaitlist(db: D1Database, args: { patientId: string; provider: string; serviceCode?: string; priority?: number; reason?: string; user?: string }): Promise<{ id: string }> {
  const id = uuidv7();
  await db.prepare(`INSERT INTO scheduling_waitlist (id, patient_id, provider, service_code, priority, reason) VALUES (?,?,?,?,?,?)`)
    .bind(id, args.patientId, args.provider, args.serviceCode ?? null, args.priority ?? 0, args.reason ?? null).run();
  return { id };
}

export type FillResult = { filled: true; appointmentId: string; patientId: string; waitlistId: string } | { filled: false; reason: 'slot_unavailable' | 'no_candidate' };

/** Fill a released slot from the waiting list (APT-004): highest-priority
 * compatible entry (domain ordering) is booked. Deterministic + race-safe. */
export async function fillReleasedSlot(db: D1Database, args: { slotId: string; user?: string }): Promise<FillResult> {
  const slot = await one<{ provider: string; status: string }>(db, `SELECT provider, status FROM scheduling_slot WHERE id=?`, [args.slotId]);
  if (!slot) throw new SchedulingError('slot not found');
  if (slot.status !== 'open') return { filled: false, reason: 'slot_unavailable' };
  const rows = await many<{ id: string; provider: string; service_code: string | null; priority: number; created_at: string }>(db,
    `SELECT id, provider, service_code, priority, created_at FROM scheduling_waitlist WHERE provider=? AND status='open'`, [slot.provider]);
  const entries: WaitlistEntry[] = rows.map((x) => ({ id: x.id, provider: x.provider, serviceCode: x.service_code, priority: x.priority, createdAt: x.created_at }));
  const pick = nextWaitlistCandidate(entries, { provider: slot.provider, serviceCode: null });
  if (!pick) return { filled: false, reason: 'no_candidate' };
  const wl = await one<{ patient_id: string; service_code: string | null }>(db, `SELECT patient_id, service_code FROM scheduling_waitlist WHERE id=?`, [pick.id]);
  const appointmentId = uuidv7();
  try {
    await db.batch([
      stmt(db, `UPDATE scheduling_slot SET status='booked' WHERE id=?`, [args.slotId]),
      stmt(db, `INSERT INTO scheduling_appointment (id, slot_id, patient_id, service_code, status) VALUES (?,?,?,?, 'booked')`,
        [appointmentId, args.slotId, wl!.patient_id, wl!.service_code ?? null]),
      stmt(db, `UPDATE scheduling_waitlist SET status='filled', updated_at=${NOW} WHERE id=?`, [pick.id]),
      stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash) VALUES (?,?,'create','appointment',?,?,'success',?,?)`,
        [uuidv7(), args.user ?? null, appointmentId, wl!.patient_id, `filled from waitlist ${pick.id}`, 'appt-fill:' + appointmentId]),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) return { filled: false, reason: 'slot_unavailable' };
    throw e;
  }
  return { filled: true, appointmentId, patientId: wl!.patient_id, waitlistId: pick.id };
}

// --- Reminders (APT-005/009) ------------------------------------------------

/** Queue an appointment reminder exactly once (idempotent on appointment+kind).
 * The body never carries a sensitive reason (APT-009). */
export async function queueReminder(db: D1Database, args: { appointmentId: string; kind?: string; channel?: string; info: AppointmentInfo; sendAt?: string }): Promise<{ id: string; enqueued: boolean }> {
  const id = uuidv7();
  const kind = args.kind ?? 'reminder-24h';
  const body = appointmentReminder(args.info);
  const changed = await run(db, `INSERT INTO scheduling_reminder (id, appointment_id, kind, channel, body, send_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(appointment_id, kind) DO NOTHING`, [id, args.appointmentId, kind, args.channel ?? 'sms', body, args.sendAt ?? null]);
  if (changed > 0) return { id, enqueued: true };
  const existing = await one<{ id: string }>(db, `SELECT id FROM scheduling_reminder WHERE appointment_id=? AND kind=?`, [args.appointmentId, kind]);
  return { id: existing!.id, enqueued: false };
}

// --- Versioned appointment types (APT-007) ----------------------------------

export async function setAppointmentType(db: D1Database, args: { code: string; effectiveFrom: string; name: string; durationMin: number; prep?: string; depositMinor?: number; by?: string }): Promise<{ code: string; version: number }> {
  if (!args.code?.trim()) throw new SchedulingError('an appointment-type code is required');
  const latest = await one<{ version: number; ef: string }>(db, `SELECT version, effective_from AS ef FROM scheduling_appointment_type WHERE code=? ORDER BY version DESC LIMIT 1`, [args.code]);
  if (latest && args.effectiveFrom <= latest.ef) throw new SchedulingError(`new effective date must be after the current version's (${latest.ef})`);
  const next = latest ? latest.version + 1 : 1;
  const statements = [];
  if (latest) statements.push(stmt(db, `UPDATE scheduling_appointment_type SET effective_to=? WHERE code=? AND version=?`, [args.effectiveFrom, args.code, latest.version]));
  statements.push(stmt(db, `INSERT INTO scheduling_appointment_type (code, version, effective_from, name, duration_min, prep, deposit_minor, changed_by) VALUES (?,?,?,?,?,?,?,?)`,
    [args.code, next, args.effectiveFrom, args.name, args.durationMin, args.prep ?? null, args.depositMinor ?? 0, args.by ?? null]));
  await db.batch(statements);
  return { code: args.code, version: next };
}

export async function resolveAppointmentType(db: D1Database, args: { code: string; asOf: string }): Promise<AppointmentType | null> {
  const x = await one<{ code: string; version: number; name: string; duration_min: number; prep: string | null; deposit_minor: number }>(db,
    `SELECT code, version, name, duration_min, prep, deposit_minor FROM scheduling_appointment_type
     WHERE code=? AND effective_from <= ? AND (effective_to IS NULL OR ? < effective_to) ORDER BY version DESC LIMIT 1`, [args.code, args.asOf, args.asOf]);
  if (!x) return null;
  return { code: x.code, version: x.version, name: x.name, durationMin: x.duration_min, prep: x.prep, depositMinor: Number(x.deposit_minor) };
}
