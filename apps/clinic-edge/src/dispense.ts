/**
 * The atomic dispense workflow (BR-008, MED-007/008/010) — the heart of the
 * vertical slice. In production every step below is committed inside ONE local
 * PostgreSQL transaction, so the user is told "saved" only after the whole set
 * is durable (SYN-002). Here we compute the transaction plan from shared domain
 * logic; the edge server wraps it in a real DB transaction.
 */
import {
  type Lot,
  type StockMovement,
  fefoPick,
  planCostMinor,
  money,
  postDispenseCogs,
  postInvoiceFinalised,
  type JournalBatch,
  uuidv7,
} from '@sancta/domain';

export type DispenseRequest = {
  readonly sku: string;
  readonly quantity: number;
  readonly patientId: string;
  readonly encounterId: string;
  readonly invoiceId: string;
  readonly chargeMinor: number; // patient charge for the medicine line
  readonly asOfDate: string;
  readonly postingDate: string;
  readonly location: string;
  readonly device: string;
  readonly user: string;
  readonly site: string;
};

export type DispensePlan = {
  readonly movements: readonly StockMovement[];
  readonly cogs: JournalBatch;
  readonly revenue: JournalBatch;
  readonly cogsMinor: number;
  readonly idempotencyKey: string;
};

/**
 * Build the atomic dispense plan: FEFO stock decrements (blocking expired /
 * quarantined / recalled lots), the COGS journal and the revenue journal. Throws
 * if stock is insufficient — nothing is committed (all-or-nothing, BR-008).
 */
export function planDispense(
  req: DispenseRequest,
  lots: readonly Lot[],
  movements: readonly StockMovement[],
  now?: number,
): DispensePlan {
  const pick = fefoPick(lots, movements, req.sku, req.quantity, req.asOfDate);

  const stockMovements: StockMovement[] = pick.map((p) => ({
    id: uuidv7(now),
    sku: req.sku,
    lotId: p.lotId,
    location: req.location,
    type: 'dispense',
    quantity: -p.quantity, // decrement
    occurredAt: req.postingDate + 'T00:00:00Z',
  }));

  const cogsMinor = planCostMinor(pick);
  const cogs = postDispenseCogs(
    { batchId: uuidv7(now), postingDate: req.postingDate },
    req.invoiceId,
    money(cogsMinor),
  );
  const revenue = postInvoiceFinalised(
    { batchId: uuidv7(now), postingDate: req.postingDate },
    req.invoiceId,
    money(req.chargeMinor),
    'medicine',
  );

  return {
    movements: stockMovements,
    cogs,
    revenue,
    cogsMinor,
    idempotencyKey: `dispense:${req.encounterId}:${req.sku}:${req.quantity}`,
  };
}
