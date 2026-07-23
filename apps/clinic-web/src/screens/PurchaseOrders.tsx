import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Line = { sku: string; quantity: string; unitCost: string };

/**
 * Purchase orders (INV-003). A PO is raised only FROM an approved requisition — the
 * clinic hub rejects a PO against a requisition that is not approved, so the approval
 * gate is enforced server-side, not here. Each line carries a quantity and unit cost
 * so the order value is explicit. Raising a PO is a confirmed-commit write (§9.2)
 * with the draft preserved on failure. No unscoped list read on mount — the operator
 * supplies the approved requisition id.
 */
export function PurchaseOrders() {
  const [reference, setReference] = useState('');
  const [requisitionId, setRequisitionId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [lines, setLines] = useState<Line[]>([{ sku: '', quantity: '', unitCost: '' }]);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { sku: '', quantity: '', unitCost: '' }]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));

  const parsedLines = lines.map((l) => ({
    sku: l.sku.trim(),
    quantity: Math.floor(Number(l.quantity)),
    unitCostMinor: Math.round((Number(l.unitCost) || 0) * 100),
  }));
  const validLines = parsedLines.filter((l) => l.sku !== '' && Number.isFinite(l.quantity) && l.quantity > 0);
  const orderTotalMinor = validLines.reduce((s, l) => s + l.quantity * l.unitCostMinor, 0);
  const canSubmit = reference.trim() !== '' && requisitionId.trim() !== '' && supplier.trim() !== '' && validLines.length > 0;

  const disabledReason = reference.trim() === '' ? 'Enter a PO reference'
    : requisitionId.trim() === '' ? 'Enter the approved requisition id'
    : supplier.trim() === '' ? 'Enter the supplier'
    : validLines.length === 0 ? 'Add at least one line with a SKU and quantity'
    : undefined;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/procurement/purchase-order',
      {
        reference: reference.trim(),
        requisitionId: requisitionId.trim(),
        supplier: supplier.trim(),
        lines: validLines,
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `Purchase order ${reference.trim()} raised to ${supplier.trim()} (${validLines.length} line${validLines.length === 1 ? '' : 's'}, ${money(orderTotalMinor)}). Reference ···${res.data.id.slice(-8)}. The requisition is now marked ordered.` });
      setReference(''); setRequisitionId(''); setSupplier(''); setLines([{ sku: '', quantity: '', unitCost: '' }]); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was raised — your draft is kept; retry when connected.' });
    } else {
      // e.g. "only an approved requisition can become a purchase order".
      setMsg({ tone: 'danger', text: `Could not raise the purchase order (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your draft is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Purchase orders">
      <div className="scr__card" data-testid="po-form">
        <h3 className="scr__section-title">Raise a purchase order (INV-003)</h3>
        <p className="scr__kpi-meta">A PO can only be raised from an APPROVED requisition — the clinic hub rejects one raised against a requisition that has not been approved.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="PO reference" hint="Your purchase order reference" data-testid="po-reference" value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
          <Field label="Approved requisition id" hint="The requisition this PO fulfils" data-testid="po-requisition" value={requisitionId} onChange={(e) => setRequisitionId(e.currentTarget.value)} />
          <Field label="Supplier" hint="Who the order is placed with" data-testid="po-supplier" value={supplier} onChange={(e) => setSupplier(e.currentTarget.value)} />
        </div>

        <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <table className="scr__table" data-testid="po-lines">
            <caption className="sancta-visually-hidden">Purchase order lines — SKU, quantity and unit cost</caption>
            <thead><tr><th scope="col">SKU</th><th scope="col" style={{ textAlign: 'right' }}>Quantity</th><th scope="col" style={{ textAlign: 'right' }}>Unit cost</th><th scope="col" style={{ textAlign: 'right' }}>Line total</th><th scope="col"></th></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const p = parsedLines[i]!;
                const lineTotal = Number.isFinite(p.quantity) && p.quantity > 0 ? p.quantity * p.unitCostMinor : 0;
                return (
                  <tr key={i}>
                    <td><Field label={`SKU for line ${i + 1}`} hideLabel data-testid={`po-line-sku-${i}`} value={l.sku} onChange={(e) => setLine(i, { sku: e.currentTarget.value })} /></td>
                    <td style={{ textAlign: 'right' }}><Field label={`Quantity for line ${i + 1}`} hideLabel numeric min={1} step={1} data-testid={`po-line-qty-${i}`} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.currentTarget.value })} style={{ maxWidth: 110, marginInlineStart: 'auto' }} /></td>
                    <td style={{ textAlign: 'right' }}><Field label={`Unit cost for line ${i + 1}`} hideLabel numeric min={0} step="0.01" prefix="$" data-testid={`po-line-cost-${i}`} value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.currentTarget.value })} style={{ maxWidth: 130, marginInlineStart: 'auto' }} /></td>
                    <td data-numeric style={{ textAlign: 'right' }}>{money(lineTotal)}</td>
                    <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`po-line-remove-${i}`} {...(lines.length === 1 ? { disabledReason: 'A purchase order needs at least one line' } : {})} onClick={() => removeLine(i)}>Remove</Button></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                <td>Order total</td><td></td><td></td>
                <td data-numeric style={{ textAlign: 'right' }} data-testid="po-total">{money(orderTotalMinor)}</td><td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="secondary" icon={<Icon name="draft" />} data-testid="po-add-line" onClick={addLine}>Add line</Button>
          <StatusTag tone="neutral" icon="info">{`${validLines.length} line${validLines.length === 1 ? '' : 's'} · ${money(orderTotalMinor)}`}</StatusTag>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="po-submit" disabled={busy}
            {...(disabledReason ? { disabledReason } : {})}
            onClick={submit}>Raise purchase order</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
