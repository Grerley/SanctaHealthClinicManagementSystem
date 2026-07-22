/**
 * Orders, results and the critical-result acknowledgement workflow on D1
 * (ORD-001..009, UAT-06). Ported from the Postgres edge `orders.ts`.
 *
 * D1 translations from the Postgres original:
 *  - No interactive transactions / FOR UPDATE → multi-statement atomic writes use
 *    db.batch(); status transitions are guarded optimistically with WHERE status=?.
 *  - No sequence for specimen accession → COALESCE(MAX(accession_seq),0)+1.
 *  - Results stay append-only; a correction inserts a superseding row and marks
 *    the original 'corrected' in the same batch, so the original is never lost.
 */
import {
  uuidv7, classifyResult, assertTransition, ORDER_TRANSITIONS, type OrderState,
  initialsOf, specimenLabel, formatAccession, type SpecimenLabel,
} from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, run, stmt } from './query.ts';

const NOW = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;

export class OrderError extends Error {}

export async function createOrder(
  db: D1Database,
  args: { patientId: string; encounterId?: string; category: string; code: string; priority?: string; indication?: string; requestedBy?: string },
): Promise<{ orderId: string }> {
  const orderId = uuidv7();
  await db.prepare(
    `INSERT INTO clinical_service_request (id, patient_id, encounter_id, category, code, priority, indication, status, requested_by)
     VALUES (?,?,?,?,?,?,?,'active',?)`,
  ).bind(orderId, args.patientId, args.encounterId ?? null, args.category, args.code, args.priority ?? 'routine', args.indication ?? null, args.requestedBy ?? null).run();
  return { orderId };
}

export async function setOrderStatus(db: D1Database, args: { orderId: string; to: OrderState }): Promise<{ status: OrderState }> {
  const cur = await one<{ status: string }>(db, `SELECT status FROM clinical_service_request WHERE id=?`, [args.orderId]);
  if (!cur) throw new OrderError('order not found');
  assertTransition(ORDER_TRANSITIONS, cur.status as OrderState, args.to); // throws on illegal move
  // Optimistic guard: only advance if the status is still what we validated against.
  const changed = await run(db, `UPDATE clinical_service_request SET status=?, updated_at=${NOW} WHERE id=? AND status=?`, [args.to, args.orderId, cur.status]);
  if (changed === 0) throw new OrderError('order changed concurrently');
  return { status: args.to };
}

export type ReleaseResultBody = {
  orderId: string; value: number; unit?: string;
  refLow?: number; refHigh?: number; criticalLow?: number; criticalHigh?: number; verifiedBy?: string;
};
export type ReleaseResultOut = { resultId: string; abnormal: string; critical: boolean };

/** Release a verified result: classify, store, complete the order; if critical it
 * stays open on the acknowledgement queue (ORD-005/006). Atomic batch. */
export async function releaseResult(db: D1Database, args: ReleaseResultBody): Promise<ReleaseResultOut> {
  const cls = classifyResult(args.value, { refLow: args.refLow, refHigh: args.refHigh, criticalLow: args.criticalLow, criticalHigh: args.criticalHigh });
  const ord = await one<{ patient_id: string; status: string }>(db, `SELECT patient_id, status FROM clinical_service_request WHERE id=?`, [args.orderId]);
  if (!ord) throw new OrderError('order not found');
  const resultId = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO clinical_result (id, service_request_id, patient_id, value, unit, ref_low, ref_high, abnormal, critical, verified_by)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [resultId, args.orderId, ord.patient_id, args.value, args.unit ?? null, args.refLow ?? null, args.refHigh ?? null, cls.abnormal, cls.critical ? 1 : 0, args.verifiedBy ?? null]),
    // Progress the order towards completed through the allowed path (each guarded).
    stmt(db, `UPDATE clinical_service_request SET status='accepted' WHERE id=? AND status='active'`, [args.orderId]),
    stmt(db, `UPDATE clinical_service_request SET status='in_progress' WHERE id=? AND status='accepted'`, [args.orderId]),
    stmt(db, `UPDATE clinical_service_request SET status='completed', updated_at=${NOW} WHERE id=? AND status='in_progress'`, [args.orderId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash)
              VALUES (?,?,'create','result',?,?,'success',?,?)`,
      [uuidv7(), args.verifiedBy ?? null, resultId, ord.patient_id, cls.critical ? 'critical result released' : 'result released', 'result:' + resultId]),
  ]);
  return { resultId, abnormal: cls.abnormal, critical: cls.critical };
}

/** Acknowledge a critical result (ORD-006). Idempotent via UNIQUE(result_id). */
export async function acknowledgeCritical(db: D1Database, args: { resultId: string; acknowledgedBy: string; action?: string }): Promise<{ ok: true }> {
  await db.batch([
    stmt(db, `INSERT INTO clinical_critical_result_ack (id, result_id, acknowledged_by, action) VALUES (?,?,?,?)
              ON CONFLICT(result_id) DO NOTHING`, [uuidv7(), args.resultId, args.acknowledgedBy, args.action ?? null]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash)
              VALUES (?,?,'approve','critical_result',?,'success','acknowledged',?)`, [uuidv7(), args.acknowledgedBy, args.resultId, 'crit-ack:' + args.resultId]),
  ]);
  return { ok: true };
}

/** Open critical results: released, critical, not yet acknowledged (ORD-006 queue). */
export async function outstandingCriticalResults(db: D1Database): Promise<Array<{ resultId: string; patientId: string; value: number; abnormal: string; releasedAt: string }>> {
  const rows = await many<{ id: string; patient_id: string; value: number; abnormal: string; released_at: string }>(
    db,
    `SELECT r.id, r.patient_id, r.value, r.abnormal, r.released_at
     FROM clinical_result r LEFT JOIN clinical_critical_result_ack a ON a.result_id = r.id
     WHERE r.critical = 1 AND a.id IS NULL ORDER BY r.released_at ASC`,
  );
  return rows.map((r) => ({ resultId: r.id, patientId: r.patient_id, value: Number(r.value), abnormal: r.abnormal, releasedAt: r.released_at }));
}

// --- ORD-007 external results + reconciliation --------------------------------

export type ExternalResultBody = { orderRef: string; patientId?: string; value?: number; unit?: string; abnormal?: string; source?: string };

export async function attachExternalResult(db: D1Database, body: ExternalResultBody): Promise<{ id: string; matched: boolean; serviceRequestId: string | null }> {
  if (!body.orderRef?.trim()) throw new OrderError('an order reference is required');
  const sql = `SELECT id FROM clinical_service_request
     WHERE status IN ('active','accepted','in_progress') AND (code=? OR id=?)
     ${body.patientId ? 'AND patient_id=?' : ''}
     ORDER BY created_at DESC LIMIT 1`;
  const params = body.patientId ? [body.orderRef, body.orderRef, body.patientId] : [body.orderRef, body.orderRef];
  const match = await one<{ id: string }>(db, sql, params);
  const serviceRequestId = match?.id ?? null;
  const id = uuidv7();
  await db.prepare(
    `INSERT INTO clinical_external_result (id, order_ref, patient_id, value, unit, abnormal, source, status, service_request_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(id, body.orderRef, body.patientId ?? null, body.value ?? null, body.unit ?? null, body.abnormal ?? 'normal', body.source ?? null, serviceRequestId ? 'matched' : 'unmatched', serviceRequestId).run();
  return { id, matched: serviceRequestId !== null, serviceRequestId };
}

export async function reconcileExternalResult(db: D1Database, args: { externalResultId: string; serviceRequestId: string; by: string }): Promise<{ id: string; status: 'matched' }> {
  if (!args.by) throw new OrderError('reconciliation requires an operator');
  const sr = await one(db, `SELECT 1 AS ok FROM clinical_service_request WHERE id=?`, [args.serviceRequestId]);
  if (!sr) throw new OrderError('order not found');
  const changed = await run(db, `UPDATE clinical_external_result SET status='matched', service_request_id=?, reconciled_by=?, reconciled_at=${NOW}
     WHERE id=? AND status='unmatched'`, [args.serviceRequestId, args.by, args.externalResultId]);
  if (changed === 0) throw new OrderError('external result not found or already matched');
  await db.prepare(
    `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash)
     VALUES (?,?,'amend','external_result',?,'success',?,?)`,
  ).bind(uuidv7(), args.by, args.externalResultId, `reconciled to order ${args.serviceRequestId}`, 'reconcile:' + args.externalResultId).run();
  return { id: args.externalResultId, status: 'matched' };
}

export async function unmatchedResults(db: D1Database): Promise<Array<{ id: string; orderRef: string; value: number | null; source: string | null }>> {
  const rows = await many<{ id: string; order_ref: string; value: number | null; source: string | null }>(
    db, `SELECT id, order_ref, value, source FROM clinical_external_result WHERE status='unmatched' ORDER BY received_at`);
  return rows.map((x) => ({ id: x.id, orderRef: x.order_ref, value: x.value === null ? null : Number(x.value), source: x.source }));
}

// --- ORD-009 cancel / correct without deleting --------------------------------

export async function cancelOrder(db: D1Database, args: { orderId: string; reason: string; by: string }): Promise<{ orderId: string; status: 'cancelled' }> {
  if (!args.reason?.trim()) throw new OrderError('a cancellation reason is required');
  const cur = await one<{ status: string }>(db, `SELECT status FROM clinical_service_request WHERE id=?`, [args.orderId]);
  if (!cur) throw new OrderError('order not found');
  if (cur.status === 'completed' || cur.status === 'cancelled') throw new OrderError(`a ${cur.status} order cannot be cancelled`);
  await db.batch([
    stmt(db, `UPDATE clinical_service_request SET status='cancelled', updated_at=${NOW} WHERE id=? AND status=?`, [args.orderId, cur.status]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash)
              VALUES (?,?,'amend','service_request',?,'success',?,?)`, [uuidv7(), args.by, args.orderId, 'cancelled: ' + args.reason, 'cancel-order:' + args.orderId]),
  ]);
  return { orderId: args.orderId, status: 'cancelled' };
}

/** Correct a released result WITHOUT deleting the original (ORD-009). */
export async function correctResult(db: D1Database, args: { resultId: string; newValue: number; reason: string; by: string }): Promise<{ correctedResultId: string }> {
  if (!args.reason?.trim()) throw new OrderError('a correction reason is required');
  const o = await one<{ service_request_id: string; patient_id: string; unit: string | null; ref_low: number | null; ref_high: number | null; abnormal: string; critical: number; status: string }>(
    db, `SELECT service_request_id, patient_id, unit, ref_low, ref_high, abnormal, critical, status FROM clinical_result WHERE id=?`, [args.resultId]);
  if (!o) throw new OrderError('result not found');
  if (o.status === 'corrected') throw new OrderError('result already corrected');
  const newId = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO clinical_result (id, service_request_id, patient_id, value, unit, ref_low, ref_high, abnormal, critical, verified_by, status, supersedes)
              VALUES (?,?,?,?,?,?,?,?,?,?,'final',?)`,
      [newId, o.service_request_id, o.patient_id, args.newValue, o.unit, o.ref_low, o.ref_high, o.abnormal, o.critical, args.by, args.resultId]),
    stmt(db, `UPDATE clinical_result SET status='corrected' WHERE id=? AND status='final'`, [args.resultId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, event_hash)
              VALUES (?,?,'amend','result',?,?,'success',?,?)`,
      [uuidv7(), args.by, args.resultId, o.patient_id, `corrected to ${args.newValue} (${args.reason}); original retained as ${args.resultId}`, 'correct-result:' + newId]),
  ]);
  return { correctedResultId: newId };
}

// --- Order sets (ORD-002) ---------------------------------------------------

export async function defineOrderSet(
  db: D1Database,
  args: { code: string; name: string; items: Array<{ category: string; code: string; priority?: string; indication?: string }> },
): Promise<{ code: string; itemCount: number }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new OrderError('order-set code and name are required');
  if (!args.items?.length) throw new OrderError('an order set needs at least one item');
  const batch = [
    stmt(db, `INSERT INTO clinical_order_set (code, name) VALUES (?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, active=1`, [args.code, args.name]),
    stmt(db, `DELETE FROM clinical_order_set_item WHERE set_code=?`, [args.code]),
    ...args.items.map((it) => stmt(db, `INSERT INTO clinical_order_set_item (id, set_code, category, code, priority, indication) VALUES (?,?,?,?,?,?)`,
      [uuidv7(), args.code, it.category, it.code, it.priority ?? 'routine', it.indication ?? null])),
  ];
  await db.batch(batch);
  return { code: args.code, itemCount: args.items.length };
}

/** Apply an order set: each item becomes an INDIVIDUAL DRAFT order (never auto-active). */
export async function applyOrderSet(
  db: D1Database,
  args: { setCode: string; patientId: string; encounterId?: string; requestedBy?: string },
): Promise<{ setCode: string; orderIds: string[] }> {
  const items = await many<{ category: string; code: string; priority: string; indication: string | null }>(
    db, `SELECT category, code, priority, indication FROM clinical_order_set_item WHERE set_code=? ORDER BY code`, [args.setCode]);
  if (items.length === 0) throw new OrderError(`order set not found or empty: ${args.setCode}`);
  const orderIds: string[] = [];
  const batch = items.map((it) => {
    const orderId = uuidv7();
    orderIds.push(orderId);
    return stmt(db, `INSERT INTO clinical_service_request (id, patient_id, encounter_id, category, code, priority, indication, status, requested_by)
                     VALUES (?,?,?,?,?,?,?,'draft',?)`,
      [orderId, args.patientId, args.encounterId ?? null, it.category, it.code, it.priority, it.indication ?? null, args.requestedBy ?? null]);
  });
  await db.batch(batch);
  return { setCode: args.setCode, orderIds };
}

// --- Specimen labels (ORD-004) ----------------------------------------------

/** Allocate a patient-safe specimen label (ORD-004). Accession via MAX+1 (no sequence). */
export async function generateSpecimenLabel(db: D1Database, args: { orderId: string; collectedOn?: string }): Promise<SpecimenLabel> {
  const o = await one<{ order_code: string; patient_id: string; given_name: string | null; family_name: string | null; dob: string | null; sex: string | null }>(
    db,
    `SELECT sr.code AS order_code, sr.patient_id, p.given_name, p.family_name, p.date_of_birth AS dob, p.sex
     FROM clinical_service_request sr JOIN identity_patient p ON p.id = sr.patient_id WHERE sr.id=?`,
    [args.orderId],
  );
  if (!o) throw new OrderError('order not found');
  const seqRow = await one<{ n: number }>(db, `SELECT COALESCE(MAX(accession_seq),0)+1 AS n FROM clinical_specimen`);
  const seq = Number(seqRow?.n ?? 1);
  const accession = formatAccession(seq);
  const collectedOn = args.collectedOn ?? new Date().toISOString().slice(0, 10);
  await db.prepare(`INSERT INTO clinical_specimen (id, accession, accession_seq, service_request_id, patient_id, collected_on) VALUES (?,?,?,?,?,?)`)
    .bind(uuidv7(), accession, seq, args.orderId, o.patient_id, collectedOn).run();
  const initials = initialsOf(`${o.given_name ?? ''} ${o.family_name ?? ''}`.trim());
  return specimenLabel({ accession, initials, dob: o.dob ?? '1900-01-01', sex: o.sex ?? '?', orderCode: o.order_code, collectedOn });
}

// --- Outbound referrals (ORD-008) -------------------------------------------

const REFERRAL_TRANSITIONS: Record<string, string[]> = {
  sent: ['accepted', 'declined', 'closed'],
  accepted: ['closed'],
  declined: ['closed'],
  closed: [],
};

export async function createReferral(
  db: D1Database,
  args: { patientId: string; targetFacility: string; reason?: string; serviceRequestId?: string; sentBy?: string },
): Promise<{ id: string }> {
  if (!args.targetFacility?.trim()) throw new OrderError('a target facility is required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO clinical_referral (id, service_request_id, patient_id, target_facility, reason, sent_by) VALUES (?,?,?,?,?,?)`)
    .bind(id, args.serviceRequestId ?? null, args.patientId, args.targetFacility, args.reason ?? null, args.sentBy ?? null).run();
  return { id };
}

export async function updateReferral(db: D1Database, args: { referralId: string; to: string; feedback?: string }): Promise<{ status: string }> {
  const cur = await one<{ status: string }>(db, `SELECT status FROM clinical_referral WHERE id=?`, [args.referralId]);
  if (!cur) throw new OrderError('referral not found');
  if (!(REFERRAL_TRANSITIONS[cur.status] ?? []).includes(args.to)) throw new OrderError(`illegal referral transition ${cur.status} -> ${args.to}`);
  await run(db, `UPDATE clinical_referral SET status=?, feedback=COALESCE(?, feedback), updated_at=${NOW} WHERE id=? AND status=?`,
    [args.to, args.feedback ?? null, args.referralId, cur.status]);
  return { status: args.to };
}

export async function listOpenReferrals(db: D1Database): Promise<Array<{ id: string; patientId: string; targetFacility: string; status: string }>> {
  const rows = await many<{ id: string; patient_id: string; target_facility: string; status: string }>(
    db, `SELECT id, patient_id, target_facility, status FROM clinical_referral WHERE status <> 'closed' ORDER BY created_at`);
  return rows.map((x) => ({ id: x.id, patientId: x.patient_id, targetFacility: x.target_facility, status: x.status }));
}
