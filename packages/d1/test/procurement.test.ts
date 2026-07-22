/**
 * Requisitions / purchase orders / equipment on D1 (INV-003/010). Runs on real
 * SQLite (same engine as D1). Proves: segregation of duties (approver != requester),
 * the value-threshold approval gate, PO only from an approved requisition, and the
 * equipment service register + due list.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequisition, decideRequisition, createPurchaseOrder, registerEquipment, recordEquipmentService, equipmentDueService, ProcurementError } from '../src/procurement.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
});

test('requisition approval is segregated and PO needs approval first', async () => {
  const { id } = await createRequisition(db, { reference: 'REQ-1', requestedBy: 'alice', lines: [{ sku: 'AMOX-500', quantity: 100 }], estValueMinor: 5000 });
  // A PO before approval is refused.
  await assert.rejects(() => createPurchaseOrder(db, { reference: 'PO-1', requisitionId: id, supplier: 'Acme', lines: [{ sku: 'AMOX-500', quantity: 100 }] }), ProcurementError);
  // The requester cannot approve their own requisition (SoD).
  await assert.rejects(() => decideRequisition(db, { requisitionId: id, approve: true, approver: 'alice', approverRoles: ['stock'] }), Error);
  const d = await decideRequisition(db, { requisitionId: id, approve: true, approver: 'bob', approverRoles: ['stock'] });
  assert.equal(d.status, 'approved');
  const po = await createPurchaseOrder(db, { reference: 'PO-1', requisitionId: id, supplier: 'Acme', lines: [{ sku: 'AMOX-500', quantity: 100, unitCostMinor: 12 }] });
  assert.ok(po.id);
  const reqStatus = await db.prepare(`SELECT status FROM inventory_requisition WHERE id=?`).bind(id).first<{ status: string }>();
  assert.equal(reqStatus?.status, 'ordered');
});

test('a high-value requisition needs an authorised approver role', async () => {
  const { id } = await createRequisition(db, { reference: 'REQ-2', requestedBy: 'alice', lines: [{ sku: 'X', quantity: 1 }], estValueMinor: 500_000 });
  // stock role cannot approve above the threshold.
  await assert.rejects(() => decideRequisition(db, { requisitionId: id, approve: true, approver: 'bob', approverRoles: ['stock'] }), ProcurementError);
  // finance role has 'approve'.
  const d = await decideRequisition(db, { requisitionId: id, approve: true, approver: 'cfo', approverRoles: ['finance'] });
  assert.equal(d.status, 'approved');
});

test('equipment service register rolls the next-service date and lists due', async () => {
  const { id } = await registerEquipment(db, { assetTag: 'EQ-1', name: 'Autoclave', nextServiceDate: '2026-07-01' });
  assert.ok((await equipmentDueService(db, { asOf: '2026-07-22' })).some((e) => e.id === id)); // overdue
  await recordEquipmentService(db, { equipmentId: id, servicedOn: '2026-07-22', note: 'annual', nextServiceDate: '2027-07-01' });
  assert.equal((await equipmentDueService(db, { asOf: '2026-07-22' })).length, 0); // rolled forward
  await assert.rejects(() => recordEquipmentService(db, { equipmentId: 'nope', servicedOn: '2026-07-22' }), ProcurementError);
});
