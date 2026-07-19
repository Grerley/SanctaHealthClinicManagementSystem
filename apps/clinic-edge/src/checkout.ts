/**
 * The vertical-slice financial tail, persisted atomically to the edge PostgreSQL
 * (BR-008, SYN-002/003, pack §14 step 3). Given a signed encounter, this commits
 * — in ONE database transaction — the medicine dispense, the finalised invoice,
 * the patient part-payment, the double-entry journals (COGS, revenue, payment),
 * the audit event and the outbox item. The caller is told "saved" only after
 * COMMIT succeeds; a failure anywhere rolls the whole thing back.
 *
 * Idempotency (NFR-010): the checkout writes its idempotency key into
 * `security_sync.applied_change`, whose PRIMARY KEY makes a replay fail and roll
 * back — so retry never creates a duplicate transaction. The DB is the guarantee.
 */
import type { PoolClient } from 'pg';
import {
  type Lot,
  type StockMovement,
  money,
  postPaymentReceived,
  accountBalance,
  trialBalances,
  isBalanced,
  uuidv7,
  ACCOUNTS,
  type JournalBatch,
} from '@sancta/domain';
import { planDispense, type DispenseRequest } from './dispense.ts';

export type CheckoutRequest = {
  readonly dispense: DispenseRequest;
  readonly paymentMinor: number; // part-payment taken now
  readonly paymentMethod: 'cash' | 'bank' | 'mobile';
  readonly now: number;
};

export class DuplicateCheckoutError extends Error {}

async function insertJournal(client: PoolClient, batch: JournalBatch, periodId: string): Promise<void> {
  await client.query(
    `INSERT INTO finance.journal_batch (id, origin, source_type, source_id, currency, posting_date, period_id, reverses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [batch.id, batch.origin, batch.source.type, batch.source.id, batch.currency, batch.postingDate, periodId, batch.reverses ?? null],
  );
  for (const l of batch.lines) {
    await client.query(
      `INSERT INTO finance.journal_line (id, batch_id, account_code, debit_minor, credit_minor, cost_centre, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), batch.id, l.accountCode, l.debit.minor, l.credit.minor, l.costCentre ?? null, l.memo ?? null],
    );
  }
}

/**
 * Persist the checkout atomically. Loads current stock inside the transaction,
 * validates the plan (FEFO, negative-stock block via domain), and commits all
 * effects. Throws DuplicateCheckoutError on replay (unique idempotency key).
 */
export async function commitCheckout(client: PoolClient, req: CheckoutRequest): Promise<{ idempotencyKey: string; cogsMinor: number }> {
  const d = req.dispense;
  await client.query('BEGIN');
  try {
    // Load lots and movements for the SKU inside the transaction (consistent read).
    const lotRows = await client.query(
      `SELECT id, sku, to_char(expiry_date,'YYYY-MM-DD') AS expiry_date, status, unit_cost_minor
       FROM inventory.lot WHERE sku = $1`,
      [d.sku],
    );
    const lots: Lot[] = lotRows.rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      expiryDate: r.expiry_date,
      status: r.status,
      unitCostMinor: Number(r.unit_cost_minor),
    }));
    const mvRows = await client.query(
      `SELECT id, sku, lot_id, location, movement_type, quantity FROM inventory.stock_movement WHERE sku = $1`,
      [d.sku],
    );
    const movements: StockMovement[] = mvRows.rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      lotId: r.lot_id,
      location: r.location,
      type: r.movement_type,
      quantity: Number(r.quantity),
      occurredAt: '2026-07-19T00:00:00Z',
    }));

    // Domain builds the plan (FEFO + COGS + revenue). Throws if insufficient stock.
    const plan = planDispense(d, lots, movements, req.now);

    // Idempotency guard: PRIMARY KEY makes a replay fail here -> rollback.
    try {
      await client.query(`INSERT INTO security_sync.applied_change (idempotency_key) VALUES ($1)`, [plan.idempotencyKey]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new DuplicateCheckoutError(plan.idempotencyKey);
    }

    // 1. Stock movements (decrements).
    for (const m of plan.movements) {
      await client.query(
        `INSERT INTO inventory.stock_movement (id, sku, lot_id, location, movement_type, quantity, source_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [m.id, m.sku, m.lotId, m.location, m.type, m.quantity, d.encounterId],
      );
    }

    // 2. Finalised invoice + medicine line (applied fee version retained).
    await client.query(
      `INSERT INTO billing.invoice (id, invoice_number, patient_id, status, currency, finalised_at)
       VALUES ($1,$2,$3,'finalised','USD', now())`,
      [d.invoiceId, 'INV-' + d.invoiceId.slice(0, 8), d.patientId],
    );
    await client.query(
      `INSERT INTO billing.invoice_line (id, invoice_id, service_code, rule_version, standard_minor, applied_minor, tax_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(req.now), d.invoiceId, d.sku, 1, d.chargeMinor, d.chargeMinor, 0],
    );

    // 3. Payment (part-payment) + allocation.
    const paymentId = uuidv7(req.now);
    await client.query(
      `INSERT INTO billing.payment (id, receipt_number, patient_id, method, amount_minor, currency, status)
       VALUES ($1,$2,$3,$4,$5,'USD','confirmed')`,
      [paymentId, 'RCT-' + paymentId.slice(0, 8), d.patientId, req.paymentMethod, req.paymentMinor],
    );
    await client.query(
      `INSERT INTO billing.payment_allocation (id, payment_id, invoice_id, amount_minor)
       VALUES ($1,$2,$3,$4)`,
      [uuidv7(req.now), paymentId, d.invoiceId, req.paymentMinor],
    );

    // 4. Journals: revenue, COGS, payment (all balanced double-entry).
    const paymentJournal = postPaymentReceived(
      { batchId: uuidv7(req.now), postingDate: d.postingDate },
      paymentId,
      money(req.paymentMinor),
      req.paymentMethod,
    );
    const periodId = d.postingDate.slice(0, 7);
    await insertJournal(client, plan.revenue, periodId);
    await insertJournal(client, plan.cogs, periodId);
    await insertJournal(client, paymentJournal, periodId);

    // 5. Audit event (append-only, hash-chained placeholder).
    await client.query(
      `INSERT INTO audit.audit_event (id, actor_user, site_id, device_id, action, resource_type, resource_id, patient_ref, outcome, captured_at, event_hash)
       VALUES ($1,$2,$3,$4,'create','dispense',$5,$6,'success', now(), $7)`,
      [uuidv7(req.now), d.user, d.site, d.device, d.invoiceId, d.patientId, plan.idempotencyKey],
    );

    // 6. Outbox item (for background sync). Same idempotency key end-to-end.
    await client.query(
      `INSERT INTO security_sync.outbox_item (idempotency_key, entity_type, entity_id, entity_version, origin_site, device_id, user_id, schema_version, priority, dependencies, captured_at, payload)
       VALUES ($1,'checkout',$2,1,$3,$4,$5,1,50,'{}', now(), $6)`,
      [plan.idempotencyKey, d.invoiceId, d.site, d.device, d.user, JSON.stringify({ invoiceId: d.invoiceId, paymentId })],
    );

    await client.query('COMMIT');
    return { idempotencyKey: plan.idempotencyKey, cogsMinor: plan.cogsMinor };
  } catch (e) {
    if (!(e instanceof DuplicateCheckoutError)) {
      await client.query('ROLLBACK');
    }
    throw e;
  }
}

/** Reconciliation helpers used by tests and the day-close exception report (BIL-012). */
export function reconciles(journals: readonly JournalBatch[]): boolean {
  return journals.every(isBalanced) && trialBalances(journals);
}

export function patientArBalanceMinor(journals: readonly JournalBatch[]): number {
  return accountBalance(journals, ACCOUNTS.patientAR).minor;
}
