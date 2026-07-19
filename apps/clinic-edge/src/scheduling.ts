/**
 * Appointment scheduling on the edge (APT-001/002/003/006). Slots are bookable
 * windows; booking takes a FOR UPDATE lock on the slot and refuses if it is not
 * open — so a resource can never be double-booked, even under a race (APT-001).
 * Status changes go through the shared appointment state machine (pack §13.1).
 */
import type { Pool } from 'pg';
import { uuidv7, assertTransition, APPOINTMENT_TRANSITIONS, type AppointmentState } from '@sancta/domain';

export class SchedulingError extends Error {}

export async function createSlot(pool: Pool, args: { provider: string; site?: string; startsAt: string; endsAt: string }): Promise<{ slotId: string }> {
  const slotId = uuidv7();
  await pool.query(
    `INSERT INTO scheduling.slot (id, provider, site_id, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,$5,'open')`,
    [slotId, args.provider, args.site ?? null, args.startsAt, args.endsAt],
  );
  return { slotId };
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
