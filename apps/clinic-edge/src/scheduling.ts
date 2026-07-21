/**
 * Appointment scheduling on the edge (APT-001/002/003/006). Slots are bookable
 * windows; booking takes a FOR UPDATE lock on the slot and refuses if it is not
 * open — so a resource can never be double-booked, even under a race (APT-001).
 * Status changes go through the shared appointment state machine (pack §13.1).
 */
import type { Pool } from 'pg';
import {
  uuidv7,
  assertTransition,
  APPOINTMENT_TRANSITIONS,
  type AppointmentState,
  nextWaitlistCandidate,
  appointmentReminder,
  type WaitlistEntry,
  type AppointmentInfo,
} from '@sancta/domain';

export class SchedulingError extends Error {}

export async function createSlot(pool: Pool, args: { provider: string; site?: string; startsAt: string; endsAt: string; room?: string; serviceCode?: string }): Promise<{ slotId: string }> {
  const slotId = uuidv7();
  await pool.query(
    `INSERT INTO scheduling.slot (id, provider, site_id, starts_at, ends_at, status, room, service_code) VALUES ($1,$2,$3,$4,$5,'open',$6,$7)`,
    [slotId, args.provider, args.site ?? null, args.startsAt, args.endsAt, args.room ?? null, args.serviceCode ?? null],
  );
  return { slotId };
}

export type CalendarEntry = {
  slotId: string;
  provider: string;
  room: string | null;
  serviceCode: string | null;
  startsAt: string;
  endsAt: string;
  day: string; // YYYY-MM-DD (local slice of startsAt)
  status: string;
  patientMrn: string | null;
};

/**
 * Calendar feed for a date window (APT-008). Returns every slot (with any booking)
 * between `from` and `to` inclusive, ordered by time, so the client can render
 * day/week views grouped by provider, room or service. Reads locally cached data
 * so the calendar works offline.
 */
export async function calendarView(pool: Pool, args: { from: string; to: string }): Promise<CalendarEntry[]> {
  const r = await pool.query(
    `SELECT s.id, s.provider, s.room, s.service_code,
            to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
            to_char(s.ends_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
            to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
            s.status, p.mrn AS patient_mrn
     FROM scheduling.slot s
     LEFT JOIN scheduling.appointment a ON a.slot_id = s.id AND a.status NOT IN ('cancelled','no_show','left_before_seen')
     LEFT JOIN identity.patient p ON p.id = a.patient_id
     WHERE s.starts_at >= $1::date AND s.starts_at < ($2::date + interval '1 day')
     ORDER BY s.starts_at, s.provider`,
    [args.from, args.to],
  );
  return r.rows.map((x) => ({
    slotId: x.id,
    provider: x.provider,
    room: x.room,
    serviceCode: x.service_code,
    startsAt: x.starts_at,
    endsAt: x.ends_at,
    day: x.day,
    status: x.status,
    patientMrn: x.patient_mrn,
  }));
}

export type BookResult = { ok: true; appointmentId: string } | { ok: false; reason: 'slot_unavailable' };

/** Book a patient into a slot. Double-booking is impossible (lock + unique). */
export async function bookAppointment(
  pool: Pool,
  args: { slotId: string; patientId: string; serviceCode?: string; reason?: string; user?: string },
): Promise<BookResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slot = await client.query(`SELECT status FROM scheduling.slot WHERE id=$1 FOR UPDATE`, [args.slotId]);
    if (slot.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new SchedulingError('slot not found');
    }
    if (slot.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'slot_unavailable' };
    }
    const appointmentId = uuidv7();
    await client.query(`UPDATE scheduling.slot SET status='booked' WHERE id=$1`, [args.slotId]);
    await client.query(
      `INSERT INTO scheduling.appointment (id, slot_id, patient_id, service_code, reason, status) VALUES ($1,$2,$3,$4,$5,'booked')`,
      [appointmentId, args.slotId, args.patientId, args.serviceCode ?? null, args.reason ?? null],
    );
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, captured_at, event_hash)
       VALUES ($1,$2,'create','appointment',$3,$4,'success', now(), $5)`,
      [uuidv7(), args.user ?? null, appointmentId, args.patientId, 'appt:' + appointmentId],
    );
    await client.query('COMMIT');
    return { ok: true, appointmentId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Next open slot for a provider at/after a time — searches locally cached data (APT-003). */
export async function nextAvailableSlot(pool: Pool, args: { provider: string; afterIso: string }): Promise<{ slotId: string; startsAt: string } | null> {
  const res = await pool.query(
    `SELECT id, to_char(starts_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at
     FROM scheduling.slot WHERE provider=$1 AND status='open' AND starts_at >= $2
     ORDER BY starts_at ASC LIMIT 1`,
    [args.provider, args.afterIso],
  );
  if (res.rows.length === 0) return null;
  return { slotId: res.rows[0].id, startsAt: res.rows[0].starts_at };
}

/**
 * Change an appointment's status through the allowed lifecycle (APT-002/006).
 * Cancelling or marking no-show releases the slot back to open. Illegal
 * transitions are rejected (TransitionError from the domain).
 */
export async function setAppointmentStatus(pool: Pool, args: { appointmentId: string; to: AppointmentState; user?: string }): Promise<{ status: AppointmentState }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT slot_id, status FROM scheduling.appointment WHERE id=$1 FOR UPDATE`, [args.appointmentId]);
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new SchedulingError('appointment not found');
    }
    const from = cur.rows[0].status as AppointmentState;
    assertTransition(APPOINTMENT_TRANSITIONS, from, args.to); // throws on illegal move
    await client.query(`UPDATE scheduling.appointment SET status=$2, updated_at=now() WHERE id=$1`, [args.appointmentId, args.to]);
    if (args.to === 'cancelled' || args.to === 'no_show' || args.to === 'left_before_seen') {
      await client.query(`UPDATE scheduling.slot SET status='open' WHERE id=$1`, [cur.rows[0].slot_id]);
    }
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','appointment',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.user ?? null, args.appointmentId, `${from} -> ${args.to}`, 'appt-status:' + args.appointmentId + ':' + args.to],
    );
    await client.query('COMMIT');
    return { status: args.to };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Waiting list (APT-004) -------------------------------------------------

/** Add a patient to a provider's waiting list at a given priority (APT-004). */
export async function addToWaitlist(
  pool: Pool,
  args: { patientId: string; provider: string; serviceCode?: string; priority?: number; reason?: string; user?: string },
): Promise<{ id: string }> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO scheduling.waitlist (id, patient_id, provider, service_code, priority, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, args.patientId, args.provider, args.serviceCode ?? null, args.priority ?? 0, args.reason ?? null],
  );
  return { id };
}

export type FillResult =
  | { filled: true; appointmentId: string; patientId: string; waitlistId: string }
  | { filled: false; reason: 'slot_unavailable' | 'no_candidate' };

/**
 * Fill a released slot from the waiting list (APT-004). Under a slot lock: if the
 * slot is open, the highest-priority compatible waiting entry (domain ordering) is
 * booked into it and marked filled. Deterministic and race-safe.
 */
export async function fillReleasedSlot(pool: Pool, args: { slotId: string; user?: string }): Promise<FillResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slot = await client.query(`SELECT provider, status FROM scheduling.slot WHERE id=$1 FOR UPDATE`, [args.slotId]);
    if (slot.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new SchedulingError('slot not found');
    }
    if (slot.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return { filled: false, reason: 'slot_unavailable' };
    }
    const provider = slot.rows[0].provider as string;
    const rows = await client.query(
      `SELECT id, provider, service_code, priority, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM scheduling.waitlist WHERE provider=$1 AND status='open' FOR UPDATE`,
      [provider],
    );
    const entries: WaitlistEntry[] = rows.rows.map((x) => ({ id: x.id, provider: x.provider, serviceCode: x.service_code, priority: x.priority, createdAt: x.created_at }));
    const pick = nextWaitlistCandidate(entries, { provider, serviceCode: null });
    if (!pick) {
      await client.query('ROLLBACK');
      return { filled: false, reason: 'no_candidate' };
    }
    const wl = await client.query(`SELECT patient_id, service_code FROM scheduling.waitlist WHERE id=$1`, [pick.id]);
    const appointmentId = uuidv7();
    await client.query(`UPDATE scheduling.slot SET status='booked' WHERE id=$1`, [args.slotId]);
    await client.query(
      `INSERT INTO scheduling.appointment (id, slot_id, patient_id, service_code, status) VALUES ($1,$2,$3,$4,'booked')`,
      [appointmentId, args.slotId, wl.rows[0].patient_id, wl.rows[0].service_code ?? null],
    );
    await client.query(`UPDATE scheduling.waitlist SET status='filled', updated_at=now() WHERE id=$1`, [pick.id]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','appointment',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), args.user ?? null, appointmentId, wl.rows[0].patient_id, `filled from waitlist ${pick.id}`, 'appt-fill:' + appointmentId],
    );
    await client.query('COMMIT');
    return { filled: true, appointmentId, patientId: wl.rows[0].patient_id, waitlistId: pick.id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Reminders (APT-005) ----------------------------------------------------

/**
 * Queue an appointment reminder exactly once (APT-005). Idempotent on
 * (appointment, kind): an offline-created reminder that is replayed does not
 * duplicate. The body never carries a sensitive reason (APT-009).
 */
export async function queueReminder(
  pool: Pool,
  args: { appointmentId: string; kind?: string; channel?: string; info: AppointmentInfo; sendAt?: string },
): Promise<{ id: string; enqueued: boolean }> {
  const id = uuidv7();
  const kind = args.kind ?? 'reminder-24h';
  const body = appointmentReminder(args.info);
  const r = await pool.query(
    `INSERT INTO scheduling.reminder (id, appointment_id, kind, channel, body, send_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (appointment_id, kind) DO NOTHING RETURNING id`,
    [id, args.appointmentId, kind, args.channel ?? 'sms', body, args.sendAt ?? null],
  );
  if (r.rows.length > 0) return { id: r.rows[0].id, enqueued: true };
  const existing = await pool.query(`SELECT id FROM scheduling.reminder WHERE appointment_id=$1 AND kind=$2`, [args.appointmentId, kind]);
  return { id: existing.rows[0].id, enqueued: false };
}

// --- Versioned appointment types (APT-007) ----------------------------------

/** Define the next effective-dated version of an appointment type (APT-007). */
export async function setAppointmentType(
  pool: Pool,
  args: { code: string; effectiveFrom: string; name: string; durationMin: number; prep?: string; depositMinor?: number; by?: string },
): Promise<{ code: string; version: number }> {
  if (!args.code?.trim()) throw new SchedulingError('an appointment-type code is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT version, to_char(effective_from,'YYYY-MM-DD') AS ef FROM scheduling.appointment_type WHERE code=$1 ORDER BY version DESC LIMIT 1`, [args.code]);
    const latest = cur.rows[0];
    if (latest && args.effectiveFrom <= latest.ef) throw new SchedulingError(`new effective date must be after the current version's (${latest.ef})`);
    const next = latest ? latest.version + 1 : 1;
    if (latest) await client.query(`UPDATE scheduling.appointment_type SET effective_to=$3 WHERE code=$1 AND version=$2`, [args.code, latest.version, args.effectiveFrom]);
    await client.query(
      `INSERT INTO scheduling.appointment_type (code, version, effective_from, name, duration_min, prep, deposit_minor, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [args.code, next, args.effectiveFrom, args.name, args.durationMin, args.prep ?? null, args.depositMinor ?? 0, args.by ?? null],
    );
    await client.query('COMMIT');
    return { code: args.code, version: next };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type AppointmentType = { code: string; version: number; name: string; durationMin: number; prep: string | null; depositMinor: number };

/** Resolve the appointment type effective as-of a date (APT-007). */
export async function resolveAppointmentType(pool: Pool, args: { code: string; asOf: string }): Promise<AppointmentType | null> {
  const r = await pool.query(
    `SELECT code, version, name, duration_min, prep, deposit_minor FROM scheduling.appointment_type
     WHERE code=$1 AND effective_from <= $2 AND (effective_to IS NULL OR $2 < effective_to)
     ORDER BY version DESC LIMIT 1`,
    [args.code, args.asOf],
  );
  if (r.rows.length === 0) return null;
  const x = r.rows[0];
  return { code: x.code, version: x.version, name: x.name, durationMin: x.duration_min, prep: x.prep, depositMinor: Number(x.deposit_minor) };
}
