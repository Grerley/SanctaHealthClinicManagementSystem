import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

// Both reads/writes below exist on BOTH backends at the same path+method:
//   worker & edge  GET  /api/billing/invoice-outstanding   (per-invoice live balance)
//   worker & edge  POST /api/billing/allocate              (apply a payment to invoices)
type InvoiceOutstanding = { invoiceId: string; outstandingMinor: number };
const lookupInvoice = (id: string) =>
  jsonFetch<InvoiceOutstanding>(`/api/billing/invoice-outstanding?id=${encodeURIComponent(id)}`);

type Line = { invoiceId: string; amountMinor: number; outstandingMinor: number | null };

/**
 * Payment allocation (BIL-006, BR-006). A recorded payment credits the AR control
 * account once; a separate allocation decides which invoices it settles. This screen
 * applies an unallocated payment across one or more invoices: as each invoice line is
 * added its live outstanding is fetched so the cashier never blindly over-applies, and
 * the running allocation total is computed in front of them. The payment's own
 * unallocated balance is the authoritative ceiling — the hub rejects an allocation
 * that exceeds it (allocation_rejected), which is surfaced with the draft preserved.
 * Committing is a §9.2 confirmed write: a fresh idempotency key per intent so a retry
 * or queue replay never double-applies, success only on a durable commit, and the
 * entered lines kept on any failure.
 */
export function PaymentAllocation() {
  const [paymentRef, setPaymentRef] = useState('');
  const [lines, setLines] = useState<Line[]>([]);

  // Draft for the next invoice line.
  const [invRef, setInvRef] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<string | null>(null);

  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const totalMinor = lines.reduce((s, l) => s + (l.amountMinor || 0), 0);
  const anyOverInvoice = lines.some((l) => l.outstandingMinor !== null && l.amountMinor > l.outstandingMinor);

  const addLine = async () => {
    const id = invRef.trim();
    if (!id) return;
    if (lines.some((l) => l.invoiceId === id)) { setAddMsg('That invoice is already on the list.'); return; }
    setAddBusy(true); setAddMsg(null);
    let outstanding: number | null = null;
    try {
      outstanding = (await lookupInvoice(id)).outstandingMinor;
    } catch {
      // The balance is guidance only; the hub still validates on commit. Add the line
      // with an unknown balance rather than block the operator.
      outstanding = null;
    }
    setLines((prev) => [...prev, { invoiceId: id, amountMinor: outstanding && outstanding > 0 ? outstanding : 0, outstandingMinor: outstanding }]);
    setInvRef('');
    setAddBusy(false);
    // A new line changes the intent — mint a fresh key so the next commit is distinct.
    setIdemKey(newIdempotencyKey());
    setMsg(null);
  };

  const setAmount = (invoiceId: string, minor: number) => {
    setLines((prev) => prev.map((l) => (l.invoiceId === invoiceId ? { ...l, amountMinor: minor } : l)));
    setIdemKey(newIdempotencyKey());
    setMsg(null);
  };
  const removeLine = (invoiceId: string) => {
    setLines((prev) => prev.filter((l) => l.invoiceId !== invoiceId));
    setIdemKey(newIdempotencyKey());
    setMsg(null);
  };

  const canSubmit = paymentRef.trim().length > 0 && lines.length > 0 && lines.every((l) => l.amountMinor > 0);
  const disabledReason = paymentRef.trim() === '' ? 'Enter the payment reference'
    : lines.length === 0 ? 'Add at least one invoice to apply the payment to'
    : lines.some((l) => l.amountMinor <= 0) ? 'Every line needs a positive amount'
    : undefined;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ ok: boolean }>(
      '/api/billing/allocate',
      { paymentId: paymentRef.trim(), allocations: lines.map((l) => ({ invoiceId: l.invoiceId, amountMinor: l.amountMinor })) },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Applied ${money(totalMinor)} across ${lines.length} invoice${lines.length === 1 ? '' : 's'} and saved to the clinic.` });
      setLines([]); setPaymentRef(''); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'allocation_rejected') {
      setMsg({ tone: 'danger', text: 'The total exceeds the payment’s unallocated balance. Nothing was applied — your lines are kept; reduce the amounts or check the payment reference.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was applied — your lines are kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not apply the payment (${res.errorCode ?? 'error'}). Your lines are kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Payment allocation">
      <div className="scr__card" data-testid="alloc-payment">
        <h3 className="scr__section-title">Apply a payment to invoices (BIL-006)</h3>
        <p className="scr__kpi-meta">Enter the payment reference, then add each invoice it settles. The payment’s unallocated balance is the hub’s ceiling; per-invoice balances below are shown to guide the split.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Payment reference" hint="The payment or receipt id" data-testid="alloc-payment-ref" value={paymentRef}
            onChange={(e) => { setPaymentRef(e.currentTarget.value); setIdemKey(newIdempotencyKey()); setMsg(null); }} style={{ minWidth: 280 }} />
        </div>
      </div>

      <div className="scr__card" data-testid="alloc-add">
        <h3 className="scr__section-title">Add invoice</h3>
        <div className="scr__row" style={{ alignItems: 'flex-end' }}>
          <Field label="Invoice reference" hint="Its live balance is fetched on add" data-testid="alloc-inv-ref" value={invRef}
            onChange={(e) => setInvRef(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && invRef.trim() && !addBusy) void addLine(); }}
            style={{ minWidth: 280 }} />
          <Button variant="secondary" data-testid="alloc-add-submit" disabled={addBusy}
            {...(invRef.trim() === '' ? { disabledReason: 'Enter an invoice reference' } : {})}
            onClick={addLine}>Add invoice</Button>
        </div>
        {addMsg && <div style={{ marginTop: 'var(--sancta-space-2)' }}><Banner tone="warning">{addMsg}</Banner></div>}
      </div>

      {lines.length === 0
        ? <StateBlock state="empty" title="No invoices added">Add the invoices this payment settles to build the allocation.</StateBlock>
        : (
          <div>
            {anyOverInvoice && (
              <div style={{ marginBottom: 'var(--sancta-space-2)' }}>
                <Banner tone="warning" title="A line exceeds its invoice balance">Applying more than an invoice owes leaves it in credit. Confirm this is intended before committing.</Banner>
              </div>
            )}
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="alloc-lines">
                <caption className="sancta-visually-hidden">Invoices this payment will be applied to, with the amount for each and its live outstanding balance.</caption>
                <thead><tr><th scope="col">Invoice</th><th scope="col" style={{ textAlign: 'right' }}>Outstanding</th><th scope="col" style={{ textAlign: 'right' }}>Apply (cents)</th><th scope="col"></th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.invoiceId} data-testid="alloc-line">
                      <td data-numeric>···{l.invoiceId.slice(-8)}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>
                        {l.outstandingMinor === null
                          ? <StatusTag tone="neutral" icon="info">Unknown</StatusTag>
                          : money(l.outstandingMinor)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Field label={`Amount for invoice ···${l.invoiceId.slice(-8)}`} hideLabel numeric prefix="¢" min={1} step={1}
                          data-testid="alloc-line-amount" value={l.amountMinor}
                          onChange={(e) => setAmount(l.invoiceId, Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))}
                          style={{ maxWidth: 140, marginInlineStart: 'auto' }} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Button variant="subtle" density="compact" data-testid="alloc-line-remove" onClick={() => removeLine(l.invoiceId)}>Remove</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                    <td colSpan={2}>Total to apply</td>
                    <td data-numeric style={{ textAlign: 'right' }} data-testid="alloc-total">{money(totalMinor)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
              <Button variant="primary" data-testid="alloc-submit" disabled={busy}
                {...(disabledReason ? { disabledReason } : {})}
                onClick={submit}>Apply payment</Button>
              <span className="scr__kpi-meta">The hub confirms the payment can cover this before anything is applied.</span>
            </div>
          </div>
        )}

      {msg && <div data-testid="alloc-result"><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
    </section>
  );
}
