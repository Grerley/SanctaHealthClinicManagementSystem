/**
 * Requisitions, purchase orders & the equipment register on D1 (INV-003/010).
 * Requisition approval is segregated (approver != requester, BR-011) and above a
 * value threshold needs an authorised (approve) role; a PO is raised only from an
 * approved requisition; the equipment register keeps an append-only service
 * history. Ported from the Postgres edge `procurement.ts`; the RBAC + segregation
 * checks are the shared domain functions.
 */
import { uuidv7, assertSegregation, can, type Role } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class ProcurementError extends Error {}

/** Above this estimated value a requisition needs an authorised approver (SoD). */
export const SOD_APPROVAL_THRESHOLD_MINOR = 100_000;

export async function createRequisition(
  db: D1Database,
  args: { reference: string; requestedBy?: string; note?: string; lines: Array<{ sku: string; quantity: number }>; estValueMinor?: number },
): Promise<{ id: string }> {
  if (!args.reference?.trim()) throw new ProcurementError('a requisition reference is required');
  if (!args.lines?.length) throw new ProcurementError('a requisition needs at least one line');
  const id = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO inventory_requisition (id, reference, requested_by, est_value_minor, note) VALUES (?,?,?,?,?)`, [id, args.reference, args.requestedBy ?? null, args.estValueMinor ?? 0, args.note ?? null]),
    ...args.lines.map((l) => stmt(db, `INSERT INTO inventory_requisition_line (id, requisition_id, sku, quantity) VALUES (?,?,?,?)`, [uuidv7(), id, l.sku, l.quantity])),
  ]);
  return { id };
}

/** Approve/reject a requisition (INV-003). Segregation + threshold enforced, audited. */
export async function decideRequisition(
  db: D1Database,
  args: { requisitionId: string; approve: boolean; approver: string; approverRoles: readonly Role[] },
): Promise<{ status: 'approved' | 'rejected' }> {
  const cur = await one<{ requested_by: string | null; status: string; est_value_minor: number }>(db, `SELECT requested_by, status, est_value_minor FROM inventory_requisition WHERE id=?`, [args.requisitionId]);
  if (!cur) throw new ProcurementError('requisition not found');
  if (cur.status !== 'submitted') throw new ProcurementError(`requisition already ${cur.status}`);
  assertSegregation(args.approver, cur.requested_by ?? ''); // approver != requester (BR-011)
  if (Number(cur.est_value_minor) > SOD_APPROVAL_THRESHOLD_MINOR && !can(args.approverRoles, 'approve')) {
    throw new ProcurementError('this requisition exceeds the approval threshold and needs an authorised approver');
  }
  const status = args.approve ? 'approved' : 'rejected';
  await db.batch([
    stmt(db, `UPDATE inventory_requisition SET status=?, approved_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status='submitted'`, [status, args.approver, args.requisitionId]),
    stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'approve','requisition',?,'success',?,?)`,
      [uuidv7(), args.approver, args.requisitionId, `requisition ${status}`, 'req:' + args.requisitionId + ':' + status]),
  ]);
  return { status };
}

/** Raise a purchase order from an approved requisition (INV-003). */
export async function createPurchaseOrder(
  db: D1Database,
  args: { reference: string; requisitionId: string; supplier: string; lines: Array<{ sku: string; quantity: number; unitCostMinor?: number }>; createdBy?: string },
): Promise<{ id: string }> {
  if (!args.supplier?.trim()) throw new ProcurementError('a supplier is required');
  if (!args.lines?.length) throw new ProcurementError('a purchase order needs at least one line');
  const req = await one<{ status: string }>(db, `SELECT status FROM inventory_requisition WHERE id=?`, [args.requisitionId]);
  if (!req) throw new ProcurementError('requisition not found');
  if (req.status !== 'approved') throw new ProcurementError('only an approved requisition can become a purchase order');
  const id = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO inventory_purchase_order (id, reference, requisition_id, supplier, created_by) VALUES (?,?,?,?,?)`, [id, args.reference, args.requisitionId, args.supplier, args.createdBy ?? null]),
    ...args.lines.map((l) => stmt(db, `INSERT INTO inventory_purchase_order_line (id, po_id, sku, quantity, unit_cost_minor) VALUES (?,?,?,?,?)`, [uuidv7(), id, l.sku, l.quantity, l.unitCostMinor ?? 0])),
    stmt(db, `UPDATE inventory_requisition SET status='ordered' WHERE id=? AND status='approved'`, [args.requisitionId]),
  ]);
  return { id };
}

// --- Equipment register (INV-010) -------------------------------------------

export async function registerEquipment(db: D1Database, args: { assetTag: string; name: string; location?: string; custodian?: string; nextServiceDate?: string }): Promise<{ id: string }> {
  if (!args.assetTag?.trim() || !args.name?.trim()) throw new ProcurementError('asset tag and name are required');
  const id = uuidv7();
  await db.prepare(`INSERT INTO inventory_equipment (id, asset_tag, name, location, custodian, next_service_date) VALUES (?,?,?,?,?,?)`)
    .bind(id, args.assetTag, args.name, args.location ?? null, args.custodian ?? null, args.nextServiceDate ?? null).run();
  return { id };
}

/** Record a service event and roll the next-service date forward (INV-010). */
export async function recordEquipmentService(db: D1Database, args: { equipmentId: string; servicedOn: string; note?: string; performedBy?: string; nextServiceDate?: string }): Promise<{ id: string }> {
  const eq = await one(db, `SELECT 1 AS ok FROM inventory_equipment WHERE id=?`, [args.equipmentId]);
  if (!eq) throw new ProcurementError('equipment not found');
  const id = uuidv7();
  await db.batch([
    stmt(db, `INSERT INTO inventory_equipment_service (id, equipment_id, serviced_on, note, performed_by) VALUES (?,?,?,?,?)`, [id, args.equipmentId, args.servicedOn, args.note ?? null, args.performedBy ?? null]),
    stmt(db, `UPDATE inventory_equipment SET next_service_date=COALESCE(?, next_service_date), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`, [args.nextServiceDate ?? null, args.equipmentId]),
  ]);
  return { id };
}

/** Equipment due (or overdue) for service by a date (INV-010). */
export async function equipmentDueService(db: D1Database, args: { asOf: string }): Promise<Array<{ id: string; assetTag: string; name: string; nextServiceDate: string }>> {
  const rows = await many<{ id: string; asset_tag: string; name: string; next: string }>(db,
    `SELECT id, asset_tag, name, next_service_date AS next FROM inventory_equipment
     WHERE status <> 'retired' AND next_service_date IS NOT NULL AND next_service_date <= ? ORDER BY next_service_date`, [args.asOf]);
  return rows.map((x) => ({ id: x.id, assetTag: x.asset_tag, name: x.name, nextServiceDate: x.next }));
}
