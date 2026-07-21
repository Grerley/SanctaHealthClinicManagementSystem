/**
 * Patient self-service (COM-006, pack §11; future). A scoped token authenticates
 * a patient — separate from staff RBAC — so they can see their balance and
 * appointments, request a booking and signal an intent to pay. Self-service never
 * acts directly: a booking request and a payment intent are STAFF-confirmed, so a
 * patient can initiate but not self-authorise a clinical or financial change.
 */
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@sancta/domain';
import { bookAppointment } from './scheduling.ts';

export class SelfServiceError extends Error {}

/** Issue a self-service token for a patient (staff action). */
export async function issueToken(pool: Pool, args: { patientId: string; ttlHours?: number }): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(24).toString('hex');
  const ttl = Math.max(1, args.ttlHours ?? 24);
  const r = await pool.query(
    `INSERT INTO flow.self_service_token (token, patient_id, expires_at) VALUES ($1,$2, now() + ($3 || ' hours')::interval)
     RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS exp`,
    [token, args.patientId, String(ttl)],
  );
  return { token, expiresAt: r.rows[0].exp };
}

/** Revoke a token (e.g. on logout or suspected compromise). */
export async function revokeToken(pool: Pool, token: string): Promise<void> {
  await pool.query(`UPDATE flow.self_service_token SET revoked=true WHERE token=$1`, [token]);
}

/** Resolve a token to its patient, rejecting missing/revoked/expired tokens. */
async function requirePatient(pool: Pool, token: string): Promise<string> {
  if (!token?.trim()) throw new SelfServiceError('a self-service token is required');
  const r = await pool.query(`SELECT patient_id, revoked, expires_at <= now() AS expired FROM flow.self_service_token WHERE token=$1`, [token]);
  if (r.rows.length === 0) throw new SelfServiceError('invalid token');
  if (r.rows[0].revoked) throw new SelfServiceError('token revoked');
  if (r.rows[0].expired) throw new SelfServiceError('token expired');
  return r.rows[0].patient_id;
}

export type SelfSummary = {
  patient: { mrn: string | null; name: string };
  accountBalanceMinor: number;
  upcomingAppointments: Array<{ startsAt: string; provider: string; status: string }>;
  documentCount: number;
};

/** The patient's own summary — balance, upcoming appointments, document count (COM-006). */
export async function selfSummary(pool: Pool, token: string): Promise<SelfSummary> {
  const patientId = await requirePatient(pool, token);
  const p = await pool.query(`SELECT mrn, given_name, family_name FROM identity.patient WHERE id=$1`, [patientId]);
  const balance = await pool.query(
    `SELECT coalesce(sum(
        ( (SELECT coalesce(sum(applied_minor+tax_minor),0) FROM billing.invoice_line l WHERE l.invoice_id=i.id)
        - (SELECT coalesce(sum(amount_minor),0) FROM billing.payment_allocation a WHERE a.invoice_id=i.id) )
      ),0)::bigint AS balance
     FROM billing.invoice i WHERE i.patient_id=$1 AND i.status IN ('finalised','part_paid','paid')`,
    [patientId],
  );
  const appts = await pool.query(
    `SELECT to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at, s.provider, a.status
     FROM scheduling.appointment a JOIN scheduling.slot s ON s.id = a.slot_id
     WHERE a.patient_id=$1 AND a.status IN ('booked','accepted','in_progress') AND s.starts_at >= now()
     ORDER BY s.starts_at LIMIT 20`,
    [patientId],
  );
  const docs = await pool.query(`SELECT count(*)::int AS n FROM clinical.document_reference WHERE patient_id=$1`, [patientId]);
  const row = p.rows[0] ?? {};
  return {
    patient: { mrn: row.mrn ?? null, name: `${row.given_name ?? ''} ${row.family_name ?? ''}`.trim() },
    accountBalanceMinor: Number(balance.rows[0].balance),
    upcomingAppointments: appts.rows.map((x) => ({ startsAt: x.starts_at, provider: x.provider, status: x.status })),
    documentCount: Number(docs.rows[0].n),
  };
}

/** Request an appointment (COM-006). Creates a PENDING request — staff confirm; never auto-books. */
export async function requestBooking(
  pool: Pool,
  args: { token: string; provider?: string; serviceCode?: string; preferredDate?: string; note?: string },
): Promise<{ id: string; status: 'pending' }> {
  const patientId = await requirePatient(pool, args.token);
  const id = uuidv7();
  await pool.query(
    `INSERT INTO flow.booking_request (id, patient_id, provider, service_code, preferred_date, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, patientId, args.provider ?? null, args.serviceCode ?? null, args.preferredDate ?? null, args.note ?? null],
  );
  return { id, status: 'pending' };
}

/** Signal an intent to pay (COM-006). Creates a PENDING intent — a cashier reconciles it to a real payment. */
export async function recordPayIntent(
  pool: Pool,
  args: { token: string; amountMinor: number; method?: string; note?: string },
): Promise<{ id: string; status: 'pending' }> {
  const patientId = await requirePatient(pool, args.token);
  if (!(args.amountMinor > 0)) throw new SelfServiceError('a positive amount is required');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO flow.payment_intent (id, patient_id, amount_minor, method, note) VALUES ($1,$2,$3,$4,$5)`,
    [id, patientId, args.amountMinor, args.method ?? 'mobile', args.note ?? null],
  );
  return { id, status: 'pending' };
}

// --- Staff-side confirmation (COM-006) --------------------------------------

/** Pending self-service booking requests for staff to action (COM-006). */
export async function listBookingRequests(pool: Pool): Promise<Array<{ id: string; patientId: string; provider: string | null; serviceCode: string | null; preferredDate: string | null }>> {
  const r = await pool.query(
    `SELECT id, patient_id, provider, service_code, to_char(preferred_date,'YYYY-MM-DD') AS preferred FROM flow.booking_request WHERE status='pending' ORDER BY created_at`,
  );
  return r.rows.map((x) => ({ id: x.id, patientId: x.patient_id, provider: x.provider, serviceCode: x.service_code, preferredDate: x.preferred }));
}

/** Confirm a booking request by booking the patient into an open slot (COM-006). */
export async function confirmBooking(pool: Pool, args: { requestId: string; slotId: string; user?: string }): Promise<{ appointmentId: string }> {
  const req = await pool.query(`SELECT patient_id, service_code, status FROM flow.booking_request WHERE id=$1`, [args.requestId]);
  if (req.rows.length === 0) throw new SelfServiceError('booking request not found');
  if (req.rows[0].status !== 'pending') throw new SelfServiceError(`request already ${req.rows[0].status}`);
  const booked = await bookAppointment(pool, { slotId: args.slotId, patientId: req.rows[0].patient_id, ...(req.rows[0].service_code ? { serviceCode: req.rows[0].service_code } : {}), ...(args.user ? { user: args.user } : {}) });
  if (!booked.ok) throw new SelfServiceError('the chosen slot is no longer available');
  await pool.query(`UPDATE flow.booking_request SET status='confirmed', appointment_id=$2, decided_at=now() WHERE id=$1`, [args.requestId, booked.appointmentId]);
  return { appointmentId: booked.appointmentId };
}
