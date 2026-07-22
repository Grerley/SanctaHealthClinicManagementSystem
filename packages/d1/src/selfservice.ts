/**
 * Patient self-service on D1 (COM-006, §11). A scoped token authenticates a
 * patient — separate from staff RBAC — so they can see their balance and
 * appointments, request a booking and signal an intent to pay. Self-service never
 * acts directly: a booking request and a payment intent are STAFF-confirmed, so a
 * patient can initiate but not self-authorise a clinical or financial change.
 * Ported from the Postgres edge `selfservice.ts`.
 *
 * D1 translations: node:crypto randomBytes → Web Crypto getRandomValues (the
 * barrel stays node-free); interval arithmetic + AT TIME ZONE → JS-computed ISO
 * timestamps; token expiry checked in JS.
 */
import { uuidv7 } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run } from './query.ts';
import { bookAppointment } from './scheduling.ts';

export class SelfServiceError extends Error {}

function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function nowIso(): string { return new Date().toISOString().slice(0, 19) + 'Z'; }

/** Issue a self-service token for a patient (staff action). */
export async function issueToken(db: D1Database, args: { patientId: string; ttlHours?: number }): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken();
  const ttl = Math.max(1, args.ttlHours ?? 24);
  const expiresAt = new Date(Date.now() + ttl * 3_600_000).toISOString().slice(0, 19) + 'Z';
  await db.prepare(`INSERT INTO flow_self_service_token (token, patient_id, expires_at) VALUES (?,?,?)`).bind(token, args.patientId, expiresAt).run();
  return { token, expiresAt };
}

/** Revoke a token (e.g. on logout or suspected compromise). */
export async function revokeToken(db: D1Database, token: string): Promise<void> {
  await run(db, `UPDATE flow_self_service_token SET revoked=1 WHERE token=?`, [token]);
}

/** Resolve a token to its patient, rejecting missing/revoked/expired tokens. */
async function requirePatient(db: D1Database, token: string): Promise<string> {
  if (!token?.trim()) throw new SelfServiceError('a self-service token is required');
  const r = await one<{ patient_id: string; revoked: number; expires_at: string }>(db, `SELECT patient_id, revoked, expires_at FROM flow_self_service_token WHERE token=?`, [token]);
  if (!r) throw new SelfServiceError('invalid token');
  if (Number(r.revoked) === 1) throw new SelfServiceError('token revoked');
  if (r.expires_at <= nowIso()) throw new SelfServiceError('token expired');
  return r.patient_id;
}

async function balanceMinor(db: D1Database, patientId: string): Promise<number> {
  const r = await one<{ balance: number }>(db,
    `SELECT COALESCE(SUM(
        ( (SELECT COALESCE(SUM(applied_minor+tax_minor),0) FROM billing_invoice_line l WHERE l.invoice_id=i.id)
        - (SELECT COALESCE(SUM(amount_minor),0) FROM billing_payment_allocation a WHERE a.invoice_id=i.id) )
      ),0) AS balance
     FROM billing_invoice i WHERE i.patient_id=? AND i.status IN ('finalised','part_paid','paid')`, [patientId]);
  return Number(r?.balance ?? 0);
}

export type SelfSummary = {
  patient: { mrn: string | null; name: string };
  accountBalanceMinor: number;
  upcomingAppointments: Array<{ startsAt: string; provider: string; status: string }>;
  documentCount: number;
};

/** The patient's own summary — balance, upcoming appointments, document count (COM-006). */
export async function selfSummary(db: D1Database, token: string): Promise<SelfSummary> {
  const patientId = await requirePatient(db, token);
  const p = await one<{ mrn: string | null; given_name: string | null; family_name: string | null }>(db, `SELECT mrn, given_name, family_name FROM identity_patient WHERE id=?`, [patientId]);
  const accountBalanceMinor = await balanceMinor(db, patientId);
  const appts = await many<{ starts_at: string; provider: string; status: string }>(db,
    `SELECT s.starts_at, s.provider, a.status FROM scheduling_appointment a JOIN scheduling_slot s ON s.id = a.slot_id
     WHERE a.patient_id=? AND a.status IN ('booked','accepted','in_progress') AND s.starts_at >= ? ORDER BY s.starts_at LIMIT 20`, [patientId, nowIso()]);
  const docs = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM clinical_document_reference WHERE patient_id=?`, [patientId]);
  return {
    patient: { mrn: p?.mrn ?? null, name: `${p?.given_name ?? ''} ${p?.family_name ?? ''}`.trim() },
    accountBalanceMinor,
    upcomingAppointments: appts.map((x) => ({ startsAt: x.starts_at, provider: x.provider, status: x.status })),
    documentCount: Number(docs?.n ?? 0),
  };
}

/** Request an appointment (COM-006). Creates a PENDING request — staff confirm; never auto-books. */
export async function requestBooking(
  db: D1Database,
  args: { token: string; provider?: string; serviceCode?: string; preferredDate?: string; note?: string },
): Promise<{ id: string; status: 'pending' }> {
  const patientId = await requirePatient(db, args.token);
  const id = uuidv7();
  await db.prepare(`INSERT INTO flow_booking_request (id, patient_id, provider, service_code, preferred_date, note) VALUES (?,?,?,?,?,?)`)
    .bind(id, patientId, args.provider ?? null, args.serviceCode ?? null, args.preferredDate ?? null, args.note ?? null).run();
  return { id, status: 'pending' };
}

/** Signal an intent to pay (COM-006). Creates a PENDING intent — a cashier reconciles it to a real payment. */
export async function recordPayIntent(
  db: D1Database,
  args: { token: string; amountMinor: number; method?: string; note?: string },
): Promise<{ id: string; status: 'pending' }> {
  const patientId = await requirePatient(db, args.token);
  if (!(args.amountMinor > 0)) throw new SelfServiceError('a positive amount is required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO flow_payment_intent (id, patient_id, amount_minor, method, note) VALUES (?,?,?,?,?)`)
    .bind(id, patientId, args.amountMinor, args.method ?? 'mobile', args.note ?? null).run();
  return { id, status: 'pending' };
}

// --- Staff-side confirmation (COM-006) --------------------------------------

/** Pending self-service booking requests for staff to action (COM-006). */
export async function listBookingRequests(db: D1Database): Promise<Array<{ id: string; patientId: string; provider: string | null; serviceCode: string | null; preferredDate: string | null }>> {
  const rows = await many<{ id: string; patient_id: string; provider: string | null; service_code: string | null; preferred: string | null }>(db,
    `SELECT id, patient_id, provider, service_code, preferred_date AS preferred FROM flow_booking_request WHERE status='pending' ORDER BY created_at`);
  return rows.map((x) => ({ id: x.id, patientId: x.patient_id, provider: x.provider, serviceCode: x.service_code, preferredDate: x.preferred }));
}

/** Confirm a booking request by booking the patient into an open slot (COM-006). */
export async function confirmBooking(db: D1Database, args: { requestId: string; slotId: string; user?: string }): Promise<{ appointmentId: string }> {
  const req = await one<{ patient_id: string; service_code: string | null; status: string }>(db, `SELECT patient_id, service_code, status FROM flow_booking_request WHERE id=?`, [args.requestId]);
  if (!req) throw new SelfServiceError('booking request not found');
  if (req.status !== 'pending') throw new SelfServiceError(`request already ${req.status}`);
  const booked = await bookAppointment(db, { slotId: args.slotId, patientId: req.patient_id, ...(req.service_code ? { serviceCode: req.service_code } : {}), ...(args.user ? { user: args.user } : {}) });
  if (!booked.ok) throw new SelfServiceError('the chosen slot is no longer available');
  await run(db, `UPDATE flow_booking_request SET status='confirmed', appointment_id=?, decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`, [booked.appointmentId, args.requestId]);
  return { appointmentId: booked.appointmentId };
}
