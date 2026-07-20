/**
 * Orders, results and the critical-result acknowledgement workflow (ORD-001/003/
 * 005/006, UAT-06). A clinician creates a service request; a verifier releases a
 * result which is classified against its reference/critical bounds; a critical
 * result stays on an escalation queue until an authorised clinician acknowledges
 * it. Results are append-only; cancelling never deletes the original (ORD-009).
 */
import type { Pool } from 'pg';
import { uuidv7, classifyResult, assertTransition, ORDER_TRANSITIONS, type OrderState } from '@sancta/domain';

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
