/**
 * Front-desk operations on D1 (PAT-006, VIS-002). Runs on real SQLite. Proves:
 * the patient card QR is PHI-free and resolves back to the patient; and the
 * reception check-in view carries identity + balance + tasks but explicitly NO
 * clinical detail.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { patientCard, resolveCard, checkInView, FrontDeskError } from '../src/frontdesk.ts';
import { openLocalD1 } from '../src/local.ts';
import { applyD1Migrations } from '../src/migrations.ts';
import type { LocalD1 } from '../src/d1.ts';

let db: LocalD1;
const PID = 'fd-p1';
const VID = 'fd-v1';

beforeEach(async () => {
  db = await openLocalD1();
  await applyD1Migrations(db);
  await db.prepare(`INSERT OR IGNORE INTO identity_patient (id, mrn, given_name, family_name, date_of_birth) VALUES (?,?,?,?,?)`).bind(PID, 'MRN-FD1', 'Grace', 'Hopper', '1906-12-09').run();
  await db.prepare(`INSERT INTO flow_visit (id, patient_id, status) VALUES (?,?,'open')`).bind(VID, PID).run();
  await db.prepare(`INSERT INTO billing_invoice (id, invoice_number, patient_id, status, finalised_at) VALUES ('fd-inv','INV-FD','${'fd-p1'}','finalised','2026-07-01T00:00:00Z')`).run();
  await db.prepare(`INSERT INTO billing_invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, tax_minor) VALUES ('fd-l','fd-inv','X',1,2500,2500,0)`).run();
});

test('the patient card QR is PHI-free and resolves back to the patient', async () => {
  const card = await patientCard(db, PID);
  assert.equal(card.qr, 'SANCTA:PT:' + PID);
  assert.equal(/Grace|Hopper|1906/.test(card.qr), false); // no PHI in the code
  const resolved = await resolveCard(db, card.qr);
  assert.equal(resolved.patientId, PID);
  assert.equal(resolved.name, 'Grace Hopper');
  await assert.rejects(() => resolveCard(db, 'GARBAGE'), FrontDeskError);
});

test('the check-in view carries balance + tasks but no clinical detail', async () => {
  const view = await checkInView(db, VID);
  assert.equal(view.patient.name, 'Grace Hopper');
  assert.equal(view.accountBalanceMinor, 2500);
  assert.equal(view.clinicalDetailIncluded, false);
  assert.ok(view.tasks.some((t) => /balance/i.test(t)));
  await assert.rejects(() => checkInView(db, 'nope'), FrontDeskError);
});
