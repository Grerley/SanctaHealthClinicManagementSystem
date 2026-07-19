/**
 * Inventory stock movements (INV-005/006, MED-007/008, BR-007, ADR-0005).
 *
 * Core rule: stock balance is DERIVED from immutable movements — never edited
 * directly. Negative stock is blocked by default. Medicine picking uses FEFO
 * (first-expiry-first-out) and never selects expired / quarantined / recalled lots.
 */

export type MovementType =
  | 'receipt'
  | 'dispense'
  | 'issue'
  | 'transfer-in'
  | 'transfer-out'
  | 'return'
  | 'adjustment'
  | 'quarantine'
  | 'expiry'
  | 'damage'
  | 'write-off';

export type StockMovement = {
  readonly id: string;
  readonly sku: string;
  readonly lotId: string;
  readonly location: string;
  readonly type: MovementType;
  /** Signed quantity in base units: positive increases on-hand, negative decreases. */
  readonly quantity: number;
  readonly occurredAt: string; // ISO datetime
};

export type LotStatus = 'available' | 'quarantined' | 'expired' | 'recalled';

export type Lot = {
  readonly id: string;
  readonly sku: string;
  readonly expiryDate: string; // ISO date
  readonly status: LotStatus;
  /** Landed unit cost in minor units, for COGS valuation. */
  readonly unitCostMinor: number;
};

export class StockError extends Error {}

/** On-hand balance for a lot = Σ of its immutable movements (BR-007). */
export function lotBalance(movements: readonly StockMovement[], lotId: string): number {
  return movements.filter((m) => m.lotId === lotId).reduce((acc, m) => acc + m.quantity, 0);
}

/** On-hand balance for a SKU across all lots. */
export function skuBalance(movements: readonly StockMovement[], sku: string): number {
  return movements.filter((m) => m.sku === sku).reduce((acc, m) => acc + m.quantity, 0);
}

/**
 * Validate a proposed decrement before it is committed. Throws StockError if it
 * would drive the lot negative (negative stock blocked by default, INV-005).
 * Emergency override is a separate, audited high-severity path (not this function).
 */
export function assertCanDecrement(
  movements: readonly StockMovement[],
  lotId: string,
  quantity: number,
): void {
  if (quantity <= 0) throw new StockError('decrement quantity must be positive');
  const current = lotBalance(movements, lotId);
  if (current - quantity < 0) {
    throw new StockError(`insufficient stock in lot ${lotId}: have ${current}, need ${quantity}`);
  }
}

function isDispensable(lot: Lot, asOfDate: string): boolean {
  if (lot.status !== 'available') return false;
  return lot.expiryDate >= asOfDate; // not expired
}

/**
 * FEFO pick plan: choose lots for a required quantity, earliest expiry first,
 * skipping expired / quarantined / recalled lots (MED-007/008). Returns the
 * allocation, or throws if available stock is insufficient.
 */
export function fefoPick(
  lots: readonly Lot[],
  movements: readonly StockMovement[],
  sku: string,
  required: number,
  asOfDate: string,
): ReadonlyArray<{ lotId: string; quantity: number; unitCostMinor: number }> {
  if (required <= 0) throw new StockError('required quantity must be positive');

  const candidates = lots
    .filter((l) => l.sku === sku && isDispensable(l, asOfDate))
    .filter((l) => lotBalance(movements, l.id) > 0)
    .slice()
    .sort((a, b) => (a.expiryDate < b.expiryDate ? -1 : a.expiryDate > b.expiryDate ? 1 : 0));

  const plan: Array<{ lotId: string; quantity: number; unitCostMinor: number }> = [];
  let remaining = required;
  for (const lot of candidates) {
    if (remaining <= 0) break;
    const avail = lotBalance(movements, lot.id);
    const take = Math.min(avail, remaining);
    plan.push({ lotId: lot.id, quantity: take, unitCostMinor: lot.unitCostMinor });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new StockError(`insufficient dispensable stock for ${sku}: short by ${remaining}`);
  }
  return plan;
}

/** Total COGS (minor units) of a FEFO pick plan — feeds postDispenseCogs. */
export function planCostMinor(
  plan: ReadonlyArray<{ quantity: number; unitCostMinor: number }>,
): number {
  return plan.reduce((acc, p) => acc + p.quantity * p.unitCostMinor, 0);
}
