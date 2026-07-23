import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * Goods receipt into stock (INV-004). Receiving creates a lot with its batch expiry
 * and landed cost, records an immutable receipt movement, maintains the derived
 * on-hand balance and posts Dr Inventory / Cr Supplier-AP — so a dispense sees the
 * new stock and the ledger stays balanced. This is a confirmed-commit write (§9.2):
 * the goods only show received once the clinic hub durably accepts them, and the
 * entry is preserved on any failure. There is no list read here (receipts are keyed
 * by lot, not enumerable safely), so the screen is a pure action form — no
 * unscoped GET on mount.
 */
export function ReceiveGoods() {
  const [sku, setSku] = useState('');
  const [expiry, setExpiry] = useState('');
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState(''); // dollars, converted to minor on submit
  const [supplier, setSupplier] = useState('');
  const [poRef, setPoRef] = useState('');
  const [location, setLocation] = useState('MAIN');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const qtyN = Math.floor(Number(qty));
  const unitCostMinor = Math.round((Number(unitCost) || 0) * 100);
  const qtyValid = Number.isFinite(qtyN) && qtyN > 0;
  const costValid = Number.isFinite(unitCostMinor) && unitCostMinor >= 0 && unitCost.trim() !== '';
  const landedMinor = qtyValid && costValid ? qtyN * unitCostMinor : 0;
  const canSubmit = sku.trim() !== '' && expiry.trim() !== '' && qtyValid && costValid;

  const disabledReason = sku.trim() === '' ? 'Enter the product SKU'
    : expiry.trim() === '' ? 'Enter the lot expiry date'
    : !qtyValid ? 'Enter a whole quantity greater than zero'
    : !costValid ? 'Enter the unit cost'
    : undefined;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ lotId: string }>(
      '/api/stock/receive',
      {
        sku: sku.trim(),
        expiryDate: expiry,
        quantity: qtyN,
        unitCostMinor,
        location: location.trim() || 'MAIN',
        ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
        ...(poRef.trim() ? { poRef: poRef.trim() } : {}),
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.lotId) {
      setMsg({ tone: 'success', text: `Received ${qtyN} x ${sku.trim()} at ${money(unitCostMinor)} each (landed ${money(qtyN * unitCostMinor)}). Lot ···${res.data.lotId.slice(-8)} created and posted to the ledger.` });
      setSku(''); setExpiry(''); setQty(''); setUnitCost(''); setSupplier(''); setPoRef('');
      setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was received — your entry is kept; retry when connected.' });
    } else if (res.errorCode === 'receipt_rejected') {
      setMsg({ tone: 'danger', text: `The hub rejected this receipt${res.errorMessage ? `: ${res.errorMessage}` : ''}. Nothing was received — your entry is kept.` });
    } else {
      setMsg({ tone: 'danger', text: `Could not receive the goods (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Receive goods">
      <div className="scr__card" data-testid="grn-form">
        <h3 className="scr__section-title">Receive goods into stock (INV-004)</h3>
        <p className="scr__kpi-meta">A receipt creates a batch lot with its expiry and landed cost, records an immutable receipt movement, maintains the derived on-hand balance, and posts Dr Inventory / Cr Supplier-AP. The balance is never edited directly (BR-007).</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Product SKU" hint="The catalogued item being received" data-testid="grn-sku" value={sku} onChange={(e) => setSku(e.currentTarget.value)} />
          <Field label="Lot expiry date" type="date" hint="Batch expiry — flags near-expiry and blocks expired issue" data-testid="grn-expiry" value={expiry} onChange={(e) => setExpiry(e.currentTarget.value)} />
          <Field label="Quantity received" numeric min={1} step={1} hint="Whole units" data-testid="grn-qty" value={qty} onChange={(e) => setQty(e.currentTarget.value)} />
          <Field label="Unit cost" numeric min={0} step="0.01" prefix="$" hint="Landed cost per unit" data-testid="grn-unit-cost" value={unitCost} onChange={(e) => setUnitCost(e.currentTarget.value)} />
          <Field label="Supplier" optional hint="For the AP posting" data-testid="grn-supplier" value={supplier} onChange={(e) => setSupplier(e.currentTarget.value)} />
          <Field label="Purchase order ref" optional hint="Links the receipt to its PO" data-testid="grn-poref" value={poRef} onChange={(e) => setPoRef(e.currentTarget.value)} />
          <Field label="Location" hint="Stock location" data-testid="grn-location" value={location} onChange={(e) => setLocation(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <StatusTag tone={landedMinor > 0 ? 'neutral' : 'neutral'} icon="info">{`Landed cost ${money(landedMinor)}`}</StatusTag>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="grn-submit" disabled={busy}
            {...(disabledReason ? { disabledReason } : {})}
            onClick={submit}>Receive goods</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
