/**
 * Dispense-and-pay checkout on D1 (BR-008, NFR-010) — the app's hardest
 * transaction, ported from the Postgres BEGIN/COMMIT + FOR UPDATE version to a
 * single atomic D1 batch(). In ONE batch it commits: the idempotency key, the
 * FEFO stock decrements (+ guarded balance), the finalised invoice + line, the
 * part-payment + allocation, and the three balanced double-entry journals
 * (revenue, COGS, payment). Any failure — a replay (idempotency PK), or a lost
 * stock race (balance CHECK) — rolls the whole batch back. All-or-nothing without
 * a lock. The FEFO plan and the journal batches are the SAME domain logic as the
 * Postgres path; only persistence differs.
 */
import {
  fefoPick,
  planCostMinor,
  money,
  postDispenseCogs,
  postInvoiceFinalised,
  postPaymentReceived,
  uuidv7,
  StockError,
  type JournalBatch,
  type Lot,
  type StockMovement,
} from '@sancta/domain';
import type { D1Database, D1PreparedStatement } from './d1.ts';
import { many, run, stmt } from './query.ts';

export class DuplicateCheckoutError extends Error {}

export type CheckoutD1Request = {
  dispense: {
    sku: string;
    quantity: number;
    patientId: string;
    encounterId: string;
    invoiceId: string;
    chargeMinor: number;
    asOfDate: string;
    postingDate: string;
    location: string;
    device: string;
    user: string;
    site: string;
  };
  paymentMinor: number;
  paymentMethod: 'cash' | 'bank' | 'mobile';
  now: number;
  shiftId?: string;
};

/** Statements that persist a balanced journal batch (batch header + its lines). */
function journalStatements(db: D1Database, batch: JournalBatch, periodId: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [
    stmt(db, `INSERT INTO finance_journal_batch (id, origin, source_type, source_id, currency, posting_date, period_id, reverses) VALUES (?,?,?,?,?,?,?,?)`,
      [batch.id, batch.origin, batch.source.type, batch.source.id, batch.currency, batch.postingDate, periodId, batch.reverses ?? null]),
  ];
  for (const l of batch.lines) {
    out.push(stmt(db, `INSERT INTO finance_journal_line (id, batch_id, account_code, debit_minor, credit_minor, cost_centre, memo) VALUES (?,?,?,?,?,?,?)`,
      [uuidv7(), batch.id, l.accountCode, l.debit.minor, l.credit.minor, l.costCentre ?? null, l.memo ?? null]));
  }
  return out;
}

export async function commitCheckoutD1(db: D1Database, req: CheckoutD1Request): Promise<{ idempotencyKey: string; cogsMinor: number }> {
  const d = req.dispense;
  const periodId = d.postingDate.slice(0, 7);
  // Ensure the accounting period exists (idempotent, not part of the atomic unit).
  await run(db, `INSERT INTO finance_financial_period (id, status) VALUES (?, 'open') ON CONFLICT(id) DO NOTHING`, [periodId]);

  // Read lots + current balances; build the FEFO plan with the shared domain logic.
  const lotRows = await many<{ id: string; sku: string; expiry_date: string; status: string; unit_cost_minor: number }>(
    db, `SELECT id, sku, expiry_date, status, unit_cost_minor FROM inventory_lot WHERE sku=?`, [d.sku]);
  const balances = await many<{ lot_id: string; on_hand: number }>(
    db, `SELECT lot_id, on_hand FROM inventory_stock_balance WHERE sku=? AND location=?`, [d.sku, d.location]);
  const lots: Lot[] = lotRows.map((l) => ({ id: l.id, sku: l.sku, expiryDate: l.expiry_date, status: l.status as Lot['status'], unitCostMinor: Number(l.unit_cost_minor) }));
  const movements: StockMovement[] = balances.map((b) => ({ id: '', sku: d.sku, lotId: b.lot_id, location: d.location, type: 'receipt', quantity: Number(b.on_hand), occurredAt: '' }));

  const pick = fefoPick(lots, movements, d.sku, d.quantity, d.asOfDate); // throws StockError if short
  const cogsMinor = planCostMinor(pick);
  const idempotencyKey = `dispense:${d.encounterId}:${d.sku}:${d.quantity}`;

  const cogs = postDispenseCogs({ batchId: uuidv7(req.now), postingDate: d.postingDate }, d.invoiceId, money(cogsMinor));
  const revenue = postInvoiceFinalised({ batchId: uuidv7(req.now), postingDate: d.postingDate }, d.invoiceId, money(d.chargeMinor), 'medicine');
  const paymentId = uuidv7(req.now);
  const paymentJournal = postPaymentReceived({ batchId: uuidv7(req.now), postingDate: d.postingDate }, paymentId, money(req.paymentMinor), req.paymentMethod);

  const s: D1PreparedStatement[] = [];
  // 0. Idempotency — a replay trips this PRIMARY KEY and the whole batch rolls back.
  s.push(stmt(db, `INSERT INTO security_sync_applied_change (idempotency_key) VALUES (?)`, [idempotencyKey]));
  // 1. Stock: append each decrement movement AND decrement its balance (CHECK-guarded).
  for (const p of pick) {
    s.push(stmt(db, `INSERT INTO inventory_stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref) VALUES (?,?,?,?, 'dispense', ?, ?)`,
      [uuidv7(req.now), d.sku, p.lotId, d.location, -p.quantity, d.encounterId]));
    s.push(stmt(db, `UPDATE inventory_stock_balance SET on_hand = on_hand - ? WHERE lot_id=? AND location=?`, [p.quantity, p.lotId, d.location]));
  }
  // 2. Finalised invoice + medicine line.
  s.push(stmt(db, `INSERT INTO billing_invoice (id, invoice_number, patient_id, status, currency, finalised_at) VALUES (?,?,?, 'finalised','USD', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    [d.invoiceId, 'INV-' + d.invoiceId.slice(-12), d.patientId]));
  s.push(stmt(db, `INSERT INTO billing_invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, tax_minor) VALUES (?,?,?,?,?,?,0)`,
    [uuidv7(req.now), d.invoiceId, d.sku, 1, d.chargeMinor, d.chargeMinor]));
  // 3. Payment + allocation.
  s.push(stmt(db, `INSERT INTO billing_payment (id, receipt_number, patient_id, method, amount_minor, currency, status, shift_id) VALUES (?,?,?,?,?, 'USD','confirmed', ?)`,
    [paymentId, 'RCT-' + paymentId.slice(-12), d.patientId, req.paymentMethod, req.paymentMinor, req.shiftId ?? null]));
  s.push(stmt(db, `INSERT INTO billing_payment_allocation (id, payment_id, invoice_id, amount_minor) VALUES (?,?,?,?)`,
    [uuidv7(req.now), paymentId, d.invoiceId, req.paymentMinor]));
  // 4. Journals (balanced double-entry): revenue, COGS, payment.
  s.push(...journalStatements(db, revenue, periodId));
  s.push(...journalStatements(db, cogs, periodId));
  s.push(...journalStatements(db, paymentJournal, periodId));
  // 5. Audit + 6. Outbox (same idempotency key end-to-end).
  s.push(stmt(db, `INSERT INTO audit_event (id, actor_user, site_id, device_id, action, resource_type, resource_id, patient_ref, outcome, event_hash) VALUES (?,?,?,?, 'create','dispense', ?, ?, 'success', ?)`,
    [uuidv7(req.now), d.user, d.site, d.device, d.invoiceId, d.patientId, idempotencyKey]));
  s.push(stmt(db, `INSERT INTO security_sync_outbox_item (idempotency_key, entity_type, entity_id, origin_site, device_id, user_id, payload) VALUES (?, 'checkout', ?, ?, ?, ?, ?)`,
    [idempotencyKey, d.invoiceId, d.site, d.device, d.user, JSON.stringify({ invoiceId: d.invoiceId, paymentId })]));

  try {
    await db.batch(s);
  } catch (e) {
    const msg = String((e as Error).message);
    if (/applied_change/i.test(msg) || /UNIQUE constraint/i.test(msg)) throw new DuplicateCheckoutError(idempotencyKey);
    if (/CHECK constraint/i.test(msg)) throw new StockError(`insufficient stock for ${d.sku} — lost a concurrency race; retry`);
    throw e;
  }
  return { idempotencyKey, cogsMinor };
}
