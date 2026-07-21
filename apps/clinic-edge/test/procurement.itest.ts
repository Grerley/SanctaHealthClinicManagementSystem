/**
 * Requisitions/POs & equipment register (INV-003, INV-010) against real
 * PostgreSQL. Proves: requisition approval is segregated (approver != requester)
 * and above the value threshold needs an authorised role; a PO only comes from an
 * approved requisition; the equipment register tracks service and due dates.
 *
 * Skips unless DATABASE_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { allMigrationsSql } from '@sancta/db/migrations';
import { createRequisition, decideRequisition, createPurchaseOrder, registerEquipment, recordEquipmentService, equipmentDueService, ProcurementError } from '../src/procurement.ts';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const migration = allMigrationsSql();
const seed = readFileSync(join(repoRoot, 'seed/synthetic-seed.sql'), 'utf8');

let pool: pg.Pool;
let SKU: string;
const REQUESTER = '00000000-0000-7000-8000-0000000000e1';
const APPROVER = '00000000-0000-7000-8000-0000000000e2';

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS identity,organisation,scheduling,flow,clinical,billing,inventory,finance,security_sync,audit CASCADE;`);
    await c.query(migration);
    await c.query(seed);
    const r = await c.query(`SELECT sku FROM inventory.product ORDER BY sku LIMIT 1`);
    SKU = r.rows[0].sku;
  } finally {
    c.release();
  }
});
after(async () => {
  if (!skip && pool) await pool.end();
});

test('requisition approval is segregated and threshold-gated (INV-003)', { skip }, async () => {
  const { id } = await createRequisition(pool, { reference: 'REQ-001', requestedBy: REQUESTER, estValueMinor: 50_000, lines: [{ sku: SKU, quantity: 20 }] });

  // The requester cannot approve their own requisition (BR-011).
  await assert.rejects(
    decideRequisition(pool, { requisitionId: id, approve: true, approver: REQUESTER, approverRoles: ['finance'] }),
    /segregation/,
  );

  // A different, authorised approver succeeds.
  const decided = await decideRequisition(pool, { requisitionId: id, approve: true, approver: APPROVER, approverRoles: ['finance'] });
  assert.equal(decided.status, 'approved');

  // A second decision on a decided requisition is rejected.
  await assert.rejects(decideRequisition(pool, { requisitionId: id, approve: true, approver: APPROVER, approverRoles: ['finance'] }), ProcurementError);
});

test('a high-value requisition needs an authorised approver (INV-003 SoD threshold)', { skip }, async () => {
  const { id } = await createRequisition(pool, { reference: 'REQ-002', requestedBy: REQUESTER, estValueMinor: 500_000, lines: [{ sku: SKU, quantity: 500 }] });
  // 'stock' role lacks 'approve' → blocked above the threshold.
  await assert.rejects(
    decideRequisition(pool, { requisitionId: id, approve: true, approver: APPROVER, approverRoles: ['stock'] }),
    /approval threshold/,
  );
  // An authorised role clears it.
  const ok = await decideRequisition(pool, { requisitionId: id, approve: true, approver: APPROVER, approverRoles: ['finance'] });
  assert.equal(ok.status, 'approved');
});

test('a purchase order only comes from an approved requisition (INV-003)', { skip }, async () => {
  const draft = await createRequisition(pool, { reference: 'REQ-003', requestedBy: REQUESTER, estValueMinor: 10_000, lines: [{ sku: SKU, quantity: 5 }] });
  // Not yet approved → PO refused.
  await assert.rejects(
    createPurchaseOrder(pool, { reference: 'PO-003', requisitionId: draft.id, supplier: 'MedSupply Ltd', lines: [{ sku: SKU, quantity: 5, unitCostMinor: 200 }] }),
    /approved requisition/,
  );
  await decideRequisition(pool, { requisitionId: draft.id, approve: true, approver: APPROVER, approverRoles: ['finance'] });
  const po = await createPurchaseOrder(pool, { reference: 'PO-003', requisitionId: draft.id, supplier: 'MedSupply Ltd', lines: [{ sku: SKU, quantity: 5, unitCostMinor: 200 }] });
  assert.ok(po.id);
  const reqStatus = await pool.query(`SELECT status FROM inventory.requisition WHERE id=$1`, [draft.id]);
  assert.equal(reqStatus.rows[0].status, 'ordered');
});

test('the equipment register tracks service and due dates (INV-010)', { skip }, async () => {
  const eq = await registerEquipment(pool, { assetTag: 'BP-001', name: 'Blood pressure monitor', location: 'Triage', nextServiceDate: '2026-06-01' });
  // Overdue as-of July.
  let due = await equipmentDueService(pool, { asOf: '2026-07-21' });
  assert.ok(due.some((e) => e.id === eq.id));

  // Service it and push the next date out → no longer due.
  await recordEquipmentService(pool, { equipmentId: eq.id, servicedOn: '2026-07-21', note: 'Calibrated', nextServiceDate: '2027-01-01' });
  due = await equipmentDueService(pool, { asOf: '2026-07-21' });
  assert.ok(!due.some((e) => e.id === eq.id));

  const hist = await pool.query(`SELECT count(*)::int AS n FROM inventory.equipment_service WHERE equipment_id=$1`, [eq.id]);
  assert.equal(hist.rows[0].n, 1);

  // Servicing unknown equipment is rejected; a duplicate asset tag is rejected.
  await assert.rejects(recordEquipmentService(pool, { equipmentId: '00000000-0000-7000-8000-0000000000ff', servicedOn: '2026-07-21' }), ProcurementError);
  await assert.rejects(registerEquipment(pool, { assetTag: 'BP-001', name: 'Dup' }), /duplicate key|unique/i);
});
