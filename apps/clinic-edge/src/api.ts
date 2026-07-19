/**
 * Edge API handlers (pure functions over a pg Pool) for the vertical slice. These
 * are the LAN endpoints the clinic PWA calls; they commit to the local PostgreSQL
 * and never depend on the cloud being reachable (NFR-038).
 */
import type { Pool } from 'pg';
import { uuidv7 } from '@sancta/domain';
import { drain, HttpSyncTransport } from '@sancta/sync';
import { PgOutboxStore } from './outbox-store.ts';
import { commitCheckout, DuplicateCheckoutError, type CheckoutRequest } from './checkout.ts';
import { openShift, closeCashierShift } from './cashier.ts';
import type { Denomination } from '@sancta/domain';

export async function listPatients(pool: Pool): Promise<unknown[]> {
  const res = await pool.query(
    `SELECT id, mrn, given_name, family_name, to_char(date_of_birth,'DD/MM/YYYY') AS dob, sex
     FROM identity.patient ORDER BY family_name, given_name`,
  );
  return res.rows;
}

export async function stockForSku(pool: Pool, sku: string): Promise<{ sku: string; onHand: number }> {
  const res = await pool.query(`SELECT coalesce(sum(on_hand),0)::int AS n FROM inventory.stock_balance WHERE sku=$1`, [sku]);
  return { sku, onHand: res.rows[0].n as number };
}

export type CheckoutApiBody = {
  patientId: string;
  sku: string;
  quantity: number;
  chargeMinor: number;
  paymentMinor: number;
  paymentMethod: 'cash' | 'bank' | 'mobile';
  shiftId?: string;
  site?: string;
  device?: string;
  user?: string;
};

/**
 * Perform the slice checkout: create a visit + signed encounter, then commit the
 * atomic dispense-and-pay (BR-008). Returns 201-style payload or a duplicate flag.
 */
export async function doCheckout(
  pool: Pool,
  body: CheckoutApiBody,
): Promise<{ ok: true; idempotencyKey: string; invoiceId: string; cogsMinor: number } | { ok: false; duplicate: true }> {
  const site = body.site ?? '00000000-0000-7000-8000-0000000000f1';
  const device = body.device ?? '00000000-0000-7000-8000-0000000000d1';
  const user = body.user ?? '00000000-0000-7000-8000-0000000000e1';
  const visitId = uuidv7();
  const encounterId = uuidv7();
  const invoiceId = uuidv7();

  const c = await pool.connect();
  try {
    // Precondition rows: a visit and a signed encounter (EHR-008).
    await c.query(`INSERT INTO flow.visit (id, patient_id, visit_number, site_id, status) VALUES ($1,$2,$3,$4,'in_care')`, [
      visitId,
      body.patientId,
      // Derive the human-readable number from the UUID's random suffix (the
      // timestamp prefix is identical for ~65s and would collide).
      'V-' + visitId.slice(-12),
      site,
    ]);
    await c.query(
      `INSERT INTO clinical.encounter (id, visit_id, patient_id, status, form_version, signed_by, signed_at)
       VALUES ($1,$2,$3,'signed',1,$4, now())`,
      [encounterId, visitId, body.patientId, user],
    );

    const req: CheckoutRequest = {
      dispense: {
        sku: body.sku,
        quantity: body.quantity,
        patientId: body.patientId,
        encounterId,
        invoiceId,
        chargeMinor: body.chargeMinor,
        asOfDate: '2026-07-19',
        postingDate: '2026-07-19',
        location: 'MAIN',
        device,
        user,
        site,
      },
      paymentMinor: body.paymentMinor,
      paymentMethod: body.paymentMethod,
      now: 1_700_000_000_000,
      ...(body.shiftId === undefined ? {} : { shiftId: body.shiftId }),
    };

    const res = await commitCheckout(c, req);
    return { ok: true, idempotencyKey: res.idempotencyKey, invoiceId, cogsMinor: res.cogsMinor };
  } catch (e) {
    if (e instanceof DuplicateCheckoutError) return { ok: false, duplicate: true };
    throw e;
  } finally {
    c.release();
  }
}

export async function openCashierShift(pool: Pool, body: { cashier: string; site?: string; openingFloatMinor: number }): Promise<{ shiftId: string }> {
  return openShift(pool, body);
}

export type CloseShiftApiBody = {
  shiftId: string;
  denominations: Denomination[];
  toleranceMinor: number;
  approver?: string;
};

export async function closeShiftApi(pool: Pool, body: CloseShiftApiBody) {
  return closeCashierShift(pool, {
    shiftId: body.shiftId,
    denominations: body.denominations,
    toleranceMinor: body.toleranceMinor,
    ...(body.approver === undefined ? {} : { approver: body.approver }),
  });
}

export async function syncStatus(pool: Pool): Promise<{ pending: number }> {
  const store = new PgOutboxStore(pool);
  return { pending: await store.pendingCount() };
}

/** Push queued outbox items to the cloud ingress. No-op-safe when cloud is down. */
export async function syncPush(
  pool: Pool,
  cloudIngressUrl: string,
  originSite: string,
  deviceToken = 'edge-device-token',
): Promise<{ attempted: number; acknowledged: number; failed: number; deferred: number }> {
  const store = new PgOutboxStore(pool);
  const transport = new HttpSyncTransport(cloudIngressUrl, deviceToken);
  const r = await drain(store, transport, originSite);
  return { attempted: r.attempted, acknowledged: r.acknowledged, failed: r.failed, deferred: r.deferred };
}
