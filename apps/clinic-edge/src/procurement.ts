/**
 * Requisitions, purchase orders & the equipment register (INV-003, INV-010,
 * pack §8). Requisition approval is segregated — the approver may not be the
 * requester (BR-011) — and above a configured value threshold it must be an
 * authorised (approve-capable) role. A PO is raised from an approved requisition.
 * The equipment register is the fixed-asset record with an append-only service
 * history.
 */
import type { Pool } from 'pg';
import { uuidv7, assertSegregation, can, type Role } from '@sancta/domain';

export class ProcurementError extends Error {}

// Above this estimated value a requisition needs an authorised approver (SoD).
export const SOD_APPROVAL_THRESHOLD_MINOR = 100_000; // USD 1,000.00

export async function createRequisition(
  pool: Pool,
  args: { reference: string; requestedBy?: string; note?: string; lines: Array<{ sku: string; quantity: number }>; estValueMinor?: number },
): Promise<{ id: string }> {
  if (!args.reference?.trim()) throw new ProcurementError('a requisition reference is required');
  if (!args.lines?.length) throw new ProcurementError('a requisition needs at least one line');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = uuidv7();
    await client.query(
      `INSERT INTO inventory.requisition (id, reference, requested_by, est_value_minor, note) VALUES ($1,$2,$3,$4,$5)`,
      [id, args.reference, args.requestedBy ?? null, args.estValueMinor ?? 0, args.note ?? null],
    );
    for (const l of args.lines) {
      await client.query(`INSERT INTO inventory.requisition_line (id, requisition_id, sku, quantity) VALUES ($1,$2,$3,$4)`, [uuidv7(), id, l.sku, l.quantity]);
    }
    await client.query('COMMIT');
    return { id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Approve/reject a requisition (INV-003). Enforces segregation of duties (the
 * approver may not be the requester) and, above the value threshold, requires an
 * authorised (approve) role. The decision is audited.
 */
export async function decideRequisition(
  pool: Pool,
  args: { requisitionId: string; approve: boolean; approver: string; approverRoles: readonly Role[] },
): Promise<{ status: 'approved' | 'rejected' }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT requested_by, status, est_value_minor FROM inventory.requisition WHERE id=$1 FOR UPDATE`, [args.requisitionId]);
    if (cur.rows.length === 0) throw new ProcurementError('requisition not found');
    if (cur.rows[0].status !== 'submitted') throw new ProcurementError(`requisition already ${cur.rows[0].status}`);
    assertSegregation(args.approver, cur.rows[0].requested_by ?? ''); // approver != requester (BR-011)
    if (Number(cur.rows[0].est_value_minor) > SOD_APPROVAL_THRESHOLD_MINOR && !can(args.approverRoles, 'approve')) {
      throw new ProcurementError('this requisition exceeds the approval threshold and needs an authorised approver');
    }
    const status = args.approve ? 'approved' : 'rejected';
    await client.query(`UPDATE inventory.requisition SET status=$2, approved_by=$3, decided_at=now() WHERE id=$1`, [args.requisitionId, status, args.approver]);
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
       VALUES ($1,$2,'approve','requisition',$3,'success',$4, now(), $5)`,
      [uuidv7(), args.approver, args.requisitionId, `requisition ${status}`, 'req:' + args.requisitionId + ':' + status],
    );
    await client.query('COMMIT');
    return { status };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Raise a purchase order from an approved requisition (INV-003). */
export async function createPurchaseOrder(
  pool: Pool,
  args: { reference: string; requisitionId: string; supplier: string; lines: Array<{ sku: string; quantity: number; unitCostMinor?: number }>; createdBy?: string },
): Promise<{ id: string }> {
  if (!args.supplier?.trim()) throw new ProcurementError('a supplier is required');
  if (!args.lines?.length) throw new ProcurementError('a purchase order needs at least one line');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const req = await client.query(`SELECT status FROM inventory.requisition WHERE id=$1 FOR UPDATE`, [args.requisitionId]);
    if (req.rows.length === 0) throw new ProcurementError('requisition not found');
    if (req.rows[0].status !== 'approved') throw new ProcurementError('only an approved requisition can become a purchase order');
    const id = uuidv7();
    await client.query(
      `INSERT INTO inventory.purchase_order (id, reference, requisition_id, supplier, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, args.reference, args.requisitionId, args.supplier, args.createdBy ?? null],
    );
    for (const l of args.lines) {
      await client.query(`INSERT INTO inventory.purchase_order_line (id, po_id, sku, quantity, unit_cost_minor) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), id, l.sku, l.quantity, l.unitCostMinor ?? 0]);
    }
    await client.query(`UPDATE inventory.requisition SET status='ordered' WHERE id=$1`, [args.requisitionId]);
    await client.query('COMMIT');
    return { id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Equipment register (INV-010) -------------------------------------------

export async function registerEquipment(
  pool: Pool,
  args: { assetTag: string; name: string; location?: string; custodian?: string; nextServiceDate?: string },
): Promise<{ id: string }> {
  if (!args.assetTag?.trim() || !args.name?.trim()) throw new ProcurementError('asset tag and name are required');
  const id = uuidv7();
  await pool.query(
    `INSERT INTO inventory.equipment (id, asset_tag, name, location, custodian, next_service_date) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, args.assetTag, args.name, args.location ?? null, args.custodian ?? null, args.nextServiceDate ?? null],
  );
  return { id };
}

/** Record a service event and roll the next-service date forward (INV-010). */
export async function recordEquipmentService(
  pool: Pool,
  args: { equipmentId: string; servicedOn: string; note?: string; performedBy?: string; nextServiceDate?: string },
): Promise<{ id: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eq = await client.query(`SELECT id FROM inventory.equipment WHERE id=$1 FOR UPDATE`, [args.equipmentId]);
    if (eq.rows.length === 0) throw new ProcurementError('equipment not found');
    const id = uuidv7();
    await client.query(
      `INSERT INTO inventory.equipment_service (id, equipment_id, serviced_on, note, performed_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, args.equipmentId, args.servicedOn, args.note ?? null, args.performedBy ?? null],
    );
    await client.query(`UPDATE inventory.equipment SET next_service_date=COALESCE($2, next_service_date), updated_at=now() WHERE id=$1`, [args.equipmentId, args.nextServiceDate ?? null]);
    await client.query('COMMIT');
    return { id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Equipment due (or overdue) for service by a date (INV-010). */
export async function equipmentDueService(pool: Pool, args: { asOf: string }): Promise<Array<{ id: string; assetTag: string; name: string; nextServiceDate: string }>> {
  const r = await pool.query(
    `SELECT id, asset_tag, name, to_char(next_service_date,'YYYY-MM-DD') AS next FROM inventory.equipment
     WHERE status <> 'retired' AND next_service_date IS NOT NULL AND next_service_date <= $1 ORDER BY next_service_date`,
    [args.asOf],
  );
  return r.rows.map((x) => ({ id: x.id, assetTag: x.asset_tag, name: x.name, nextServiceDate: x.next }));
}
