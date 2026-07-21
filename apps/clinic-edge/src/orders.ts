/**
 * Orders, results and the critical-result acknowledgement workflow (ORD-001/003/
 * 005/006, UAT-06). A clinician creates a service request; a verifier releases a
 * result which is classified against its reference/critical bounds; a critical
 * result stays on an escalation queue until an authorised clinician acknowledges
 * it. Results are append-only; cancelling never deletes the original (ORD-009).
 */
import type { Pool } from 'pg';
import { uuidv7, classifyResult, assertTransition, ORDER_TRANSITIONS, type OrderState, initialsOf, specimenLabel, formatAccession } from '@sancta/domain';

export class OrderError extends Error {}

export async function createOrder(
  pool: Pool,
  args: { patientId: string; encounterId?: string; category: string; code: string; priority?: string; indication?: string; requestedBy?: string },
): Promise<{ orderId: string }> {
  const orderId = uuidv7();
  await pool.query(
    `INSERT INTO clinical.service_request (id, patient_id, encounter_id, category, code, priority, indication, status, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
    [orderId, args.patientId, args.encounterId ?? null, args.category, args.code, args.priority ?? 'routine', args.indication ?? null, args.requestedBy ?? null],
  );
  return { orderId };
}

export async function setOrderStatus(pool: Pool, args: { orderId: string; to: OrderState }): Promise<{ status: OrderState }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT status FROM clinical.service_request WHERE id=$1 FOR UPDATE`, [args.orderId]);
    if (cur.rows.length === 0) throw new OrderError('order not found');
    assertTransition(ORDER_TRANSITIONS, cur.rows[0].status as OrderState, args.to);
    await client.query(`UPDATE clinical.service_request SET status=$2, updated_at=now() WHERE id=$1`, [args.orderId, args.to]);
    await client.query('COMMIT');
    return { status: args.to };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export type ReleaseResultBody = {
  orderId: string;
  value: number;
  unit?: string;
  refLow?: number;
  refHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
  verifiedBy?: string;
};

export type ReleaseResultOut = { resultId: string; abnormal: string; critical: boolean };

/** Release a verified result: classify it, store it, complete the order, and if
 * critical, leave it open on the acknowledgement queue (ORD-005/006). */
export async function releaseResult(pool: Pool, args: ReleaseResultBody): Promise<ReleaseResultOut> {
  const cls = classifyResult(args.value, { refLow: args.refLow, refHigh: args.refHigh, criticalLow: args.criticalLow, criticalHigh: args.criticalHigh });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ord = await client.query(`SELECT patient_id, status FROM clinical.service_request WHERE id=$1 FOR UPDATE`, [args.orderId]);
    if (ord.rows.length === 0) throw new OrderError('order not found');
    const patientId = ord.rows[0].patient_id as string;
    const resultId = uuidv7();
    await client.query(
      `INSERT INTO clinical.result (id, service_request_id, patient_id, value, unit, ref_low, ref_high, abnormal, critical, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [resultId, args.orderId, patientId, args.value, args.unit ?? null, args.refLow ?? null, args.refHigh ?? null, cls.abnormal, cls.critical, args.verifiedBy ?? null],
    );
    // Move the order towards completed through the allowed path.
    const from = ord.rows[0].status as OrderState;
    if (from === 'active') await client.query(`UPDATE clinical.service_request SET status='accepted' WHERE id=$1`, [args.orderId]);
    await client.query(`UPDATE clinical.service_request SET status='in_progress' WHERE id=$1 AND status IN ('accepted')`, [args.orderId]);
    await client.query(`UPDATE clinical.service_request SET status='completed', updated_at=now() WHERE id=$1 AND status IN ('in_progress')`, [args.orderId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'create','result',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), args.verifiedBy ?? null, resultId, patientId, cls.critical ? 'critical result released' : 'result released', 'result:' + resultId],
    );
    await client.query('COMMIT');
    return { resultId, abnormal: cls.abnormal, critical: cls.critical };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Acknowledge a critical result (ORD-006). Idempotent via the UNIQUE(result_id). */
export async function acknowledgeCritical(pool: Pool, args: { resultId: string; acknowledgedBy: string; action?: string }): Promise<{ ok: true }> {
  await pool.query(
    `INSERT INTO clinical.critical_result_ack (id, result_id, acknowledged_by, action) VALUES ($1,$2,$3,$4)
     ON CONFLICT (result_id) DO NOTHING`,
    [uuidv7(), args.resultId, args.acknowledgedBy, args.action ?? null],
  );
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'approve','critical_result',$3,'success','acknowledged', now(), $4)`,
    [uuidv7(), args.acknowledgedBy, args.resultId, 'crit-ack:' + args.resultId],
  );
  return { ok: true };
}

/** Open critical results: released, critical, not yet acknowledged (ORD-006 queue). */
export async function outstandingCriticalResults(pool: Pool): Promise<Array<{ resultId: string; patientId: string; value: number; abnormal: string; releasedAt: string }>> {
  const res = await pool.query(
    `SELECT r.id, r.patient_id, r.value, r.abnormal, to_char(r.released_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS released_at
     FROM clinical.result r
     LEFT JOIN clinical.critical_result_ack a ON a.result_id = r.id
     WHERE r.critical = true AND a.id IS NULL
     ORDER BY r.released_at ASC`,
  );
  return res.rows.map((r) => ({ resultId: r.id, patientId: r.patient_id, value: Number(r.value), abnormal: r.abnormal, releasedAt: r.released_at }));
}

// --- ORD-007 external results + reconciliation --------------------------------

export type ExternalResultBody = { orderRef: string; patientId?: string; value?: number; unit?: string; abnormal?: string; source?: string };

/**
 * Attach an externally-sourced result (ORD-007). If an active order matches the
 * reference (service_request.code or id), the result is linked automatically;
 * otherwise it lands in the unmatched queue for manual reconciliation.
 */
export async function attachExternalResult(pool: Pool, body: ExternalResultBody): Promise<{ id: string; matched: boolean; serviceRequestId: string | null }> {
  if (!body.orderRef?.trim()) throw new OrderError('an order reference is required');
  const match = await pool.query(
    `SELECT id FROM clinical.service_request
     WHERE status IN ('active','accepted','in_progress') AND (code=$1 OR id::text=$1)
     ${body.patientId ? 'AND patient_id=$2' : ''}
     ORDER BY created_at DESC LIMIT 1`,
    body.patientId ? [body.orderRef, body.patientId] : [body.orderRef],
  );
  const serviceRequestId = match.rowCount ? match.rows[0].id : null;
  const id = uuidv7();
  await pool.query(
    `INSERT INTO clinical.external_result (id, order_ref, patient_id, value, unit, abnormal, source, status, service_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, body.orderRef, body.patientId ?? null, body.value ?? null, body.unit ?? null, body.abnormal ?? 'normal', body.source ?? null, serviceRequestId ? 'matched' : 'unmatched', serviceRequestId],
  );
  return { id, matched: serviceRequestId !== null, serviceRequestId };
}

/** Manually reconcile an unmatched external result to an order (ORD-007). Audited. */
export async function reconcileExternalResult(pool: Pool, args: { externalResultId: string; serviceRequestId: string; by: string }): Promise<{ id: string; status: 'matched' }> {
  if (!args.by) throw new OrderError('reconciliation requires an operator');
  const sr = await pool.query(`SELECT 1 FROM clinical.service_request WHERE id=$1`, [args.serviceRequestId]);
  if (sr.rowCount === 0) throw new OrderError('order not found');
  const r = await pool.query(
    `UPDATE clinical.external_result SET status='matched', service_request_id=$2, reconciled_by=$3, reconciled_at=now()
     WHERE id=$1 AND status='unmatched' RETURNING id`,
    [args.externalResultId, args.serviceRequestId, args.by],
  );
  if (r.rowCount === 0) throw new OrderError('external result not found or already matched');
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'amend','external_result',$3,'success',$4, now(), $5)`,
    [uuidv7(), args.by, args.externalResultId, `reconciled to order ${args.serviceRequestId}`, 'reconcile:' + args.externalResultId],
  );
  return { id: args.externalResultId, status: 'matched' };
}

export async function unmatchedResults(pool: Pool): Promise<Array<{ id: string; orderRef: string; value: number | null; source: string | null }>> {
  const r = await pool.query(`SELECT id, order_ref, value, source FROM clinical.external_result WHERE status='unmatched' ORDER BY received_at`);
  return r.rows.map((x) => ({ id: x.id, orderRef: x.order_ref, value: x.value === null ? null : Number(x.value), source: x.source }));
}

// --- ORD-009 cancel / correct without deleting --------------------------------

/** Cancel an order without deleting it; a reason is required and audited (ORD-009). */
export async function cancelOrder(pool: Pool, args: { orderId: string; reason: string; by: string }): Promise<{ orderId: string; status: 'cancelled' }> {
  if (!args.reason?.trim()) throw new OrderError('a cancellation reason is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT status FROM clinical.service_request WHERE id=$1 FOR UPDATE`, [args.orderId]);
    if (cur.rowCount === 0) throw new OrderError('order not found');
    if (['completed', 'cancelled'].includes(cur.rows[0].status)) throw new OrderError(`a ${cur.rows[0].status} order cannot be cancelled`);
    await client.query(`UPDATE clinical.service_request SET status='cancelled', updated_at=now() WHERE id=$1`, [args.orderId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','service_request',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.by, args.orderId, 'cancelled: ' + args.reason, 'cancel-order:' + args.orderId],
    );
    await client.query('COMMIT');
    return { orderId: args.orderId, status: 'cancelled' };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Correct a released result WITHOUT deleting the original (ORD-009). A new result
 * row supersedes the original; the original is retained and marked corrected. The
 * reason is audited. Returns the new result id.
 */
export async function correctResult(pool: Pool, args: { resultId: string; newValue: number; reason: string; by: string }): Promise<{ correctedResultId: string }> {
  if (!args.reason?.trim()) throw new OrderError('a correction reason is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orig = await client.query(`SELECT service_request_id, patient_id, unit, ref_low, ref_high, abnormal, critical, status FROM clinical.result WHERE id=$1 FOR UPDATE`, [args.resultId]);
    if (orig.rowCount === 0) throw new OrderError('result not found');
    if (orig.rows[0].status === 'corrected') throw new OrderError('result already corrected');
    const o = orig.rows[0];
    const newId = uuidv7();
    await client.query(
      `INSERT INTO clinical.result (id, service_request_id, patient_id, value, unit, ref_low, ref_high, abnormal, critical, verified_by, status, supersedes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'final',$11)`,
      [newId, o.service_request_id, o.patient_id, args.newValue, o.unit, o.ref_low, o.ref_high, o.abnormal, o.critical, args.by, args.resultId],
    );
    await client.query(`UPDATE clinical.result SET status='corrected' WHERE id=$1`, [args.resultId]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, patient_ref, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'amend','result',$3,$4,'success',$5, now(), $6)`,
      [uuidv7(), args.by, args.resultId, o.patient_id, `corrected to ${args.newValue} (${args.reason}); original retained as ${args.resultId}`, 'correct-result:' + newId],
    );
    await client.query('COMMIT');
    return { correctedResultId: newId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Order sets (ORD-002) ---------------------------------------------------

/** Define/replace a reusable order set (ORD-002). */
export async function defineOrderSet(
  pool: Pool,
  args: { code: string; name: string; items: Array<{ category: string; code: string; priority?: string; indication?: string }> },
): Promise<{ code: string; itemCount: number }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new OrderError('order-set code and name are required');
  if (!args.items?.length) throw new OrderError('an order set needs at least one item');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO clinical.order_set (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name=$2, active=true`, [args.code, args.name]);
    await client.query(`DELETE FROM clinical.order_set_item WHERE set_code=$1`, [args.code]);
    for (const it of args.items) {
      await client.query(
        `INSERT INTO clinical.order_set_item (id, set_code, category, code, priority, indication) VALUES ($1,$2,$3,$4,$5,$6)`,
        [uuidv7(), args.code, it.category, it.code, it.priority ?? 'routine', it.indication ?? null],
      );
    }
    await client.query('COMMIT');
    return { code: args.code, itemCount: args.items.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Apply an order set to a patient (ORD-002). Each item becomes an INDIVIDUAL
 * service request in DRAFT — the set is a convenience, never an auto-approve.
 * Per-patient review is preserved: nothing is active until a clinician confirms
 * each order (draft → active via setOrderStatus).
 */
export async function applyOrderSet(
  pool: Pool,
  args: { setCode: string; patientId: string; encounterId?: string; requestedBy?: string },
): Promise<{ setCode: string; orderIds: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const items = await client.query(`SELECT category, code, priority, indication FROM clinical.order_set_item WHERE set_code=$1 ORDER BY code`, [args.setCode]);
    if (items.rows.length === 0) throw new OrderError(`order set not found or empty: ${args.setCode}`);
    const orderIds: string[] = [];
    for (const it of items.rows) {
      const orderId = uuidv7();
      await client.query(
        `INSERT INTO clinical.service_request (id, patient_id, encounter_id, category, code, priority, indication, status, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)`, // DRAFT: still needs per-patient review
        [orderId, args.patientId, args.encounterId ?? null, it.category, it.code, it.priority, it.indication ?? null, args.requestedBy ?? null],
      );
      orderIds.push(orderId);
    }
    await client.query('COMMIT');
    return { setCode: args.setCode, orderIds };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Specimen labels (ORD-004) ----------------------------------------------

/**
 * Allocate a patient-safe specimen label for an order (ORD-004). A gapless
 * accession is assigned and the label is built from initials + DOB + sex only —
 * never the full name (see domain `specimenLabel`).
 */
export async function generateSpecimenLabel(pool: Pool, args: { orderId: string; collectedOn?: string }): Promise<import('@sancta/domain').SpecimenLabel> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      `SELECT sr.code AS order_code, sr.patient_id, p.given_name, p.family_name, to_char(p.date_of_birth,'YYYY-MM-DD') AS dob, p.sex
       FROM clinical.service_request sr JOIN identity.patient p ON p.id = sr.patient_id WHERE sr.id=$1`,
      [args.orderId],
    );
    if (o.rows.length === 0) throw new OrderError('order not found');
    const row = o.rows[0];
    const seq = await client.query(`SELECT nextval('clinical.specimen_accession_seq')::bigint AS n`);
    const accession = formatAccession(Number(seq.rows[0].n));
    const collectedOn = args.collectedOn ?? new Date().toISOString().slice(0, 10);
    const id = uuidv7();
    await client.query(
      `INSERT INTO clinical.specimen (id, accession, service_request_id, patient_id, collected_on) VALUES ($1,$2,$3,$4,$5)`,
      [id, accession, args.orderId, row.patient_id, collectedOn],
    );
    await client.query('COMMIT');
    const initials = initialsOf(`${row.given_name ?? ''} ${row.family_name ?? ''}`.trim());
    return specimenLabel({ accession, initials, dob: row.dob ?? '1900-01-01', sex: row.sex ?? '?', orderCode: row.order_code, collectedOn });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Outbound referrals (ORD-008) -------------------------------------------

const REFERRAL_TRANSITIONS: Record<string, string[]> = {
  sent: ['accepted', 'declined', 'closed'],
  accepted: ['closed'],
  declined: ['closed'],
  closed: [],
};

/** Create an outbound referral (ORD-008), optionally linked to a source order. */
export async function createReferral(
  pool: Pool,
  args: { patientId: string; targetFacility: string; reason?: string; serviceRequestId?: string; sentBy?: string },
): Promise<{ id: string }> {
  if (!args.targetFacility?.trim()) throw new OrderError('a target facility is required');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO clinical.referral (id, service_request_id, patient_id, target_facility, reason, sent_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, args.serviceRequestId ?? null, args.patientId, args.targetFacility, args.reason ?? null, args.sentBy ?? null],
  );
  return { id };
}

/** Advance a referral's lifecycle and record feedback/closure (ORD-008). */
export async function updateReferral(pool: Pool, args: { referralId: string; to: string; feedback?: string }): Promise<{ status: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT status FROM clinical.referral WHERE id=$1 FOR UPDATE`, [args.referralId]);
    if (cur.rows.length === 0) throw new OrderError('referral not found');
    const from = cur.rows[0].status as string;
    if (!(REFERRAL_TRANSITIONS[from] ?? []).includes(args.to)) throw new OrderError(`illegal referral transition ${from} -> ${args.to}`);
    await client.query(
      `UPDATE clinical.referral SET status=$2, feedback=COALESCE($3, feedback), updated_at=now() WHERE id=$1`,
      [args.referralId, args.to, args.feedback ?? null],
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

/** Open referrals awaiting acceptance/feedback/closure (ORD-008). */
export async function listOpenReferrals(pool: Pool): Promise<Array<{ id: string; patientId: string; targetFacility: string; status: string }>> {
  const r = await pool.query(`SELECT id, patient_id, target_facility, status FROM clinical.referral WHERE status <> 'closed' ORDER BY created_at`);
  return r.rows.map((x) => ({ id: x.id, patientId: x.patient_id, targetFacility: x.target_facility, status: x.status }));
}
