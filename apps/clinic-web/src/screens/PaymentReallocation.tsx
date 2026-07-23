import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

// Present on BOTH backends at the same path+method:
//   worker & edge  GET  /api/billing/invoice-outstanding   (balance context)
//   worker & edge  POST /api/billing/reallocate            (move allocation between invoices)
type InvoiceOutstanding = { invoiceId: string; outstandingMinor: number };
const lookupInvoice = (id: string) =>
  jsonFetch<InvoiceOutstanding>(`/api/billing/invoice-outstanding?id=${encodeURIComponent(id)}`);

type Preview = { fromMinor: number | null; toMinor: number | null };

/**
 * Payment reallocation (BIL-006, BR-006). Corrects a payment applied to the wrong
 * invoice. History is never edited: the hub appends a compensating negative entry on
 * the source invoice and a matching positive entry on the target, so the full audit
 * trail is preserved. Before committing, the operator can preview both invoices' live
 * balances so the correction is made with eyes open. The hub is authoritative on the
 * limit — it rejects moving more than is currently allocated to the source
 * (reallocation_rejected) — and this is surfaced with the entry kept. The move itself
 * is a §9.2 confirmed write: a fresh idempotency key per intent so a retry never
 * doubles the correction, success only on a durable commit.
 */
export function PaymentReallocation() {
  const [paymentRef, setPaymentRef] = useState('');
  const [fromRef, setFromRef] = useState('');
  const [toRef, setToRef] = useState('');
  const [amount, setAmount] = useState(0);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  // Any edit is a new intent — refresh the key and clear a stale preview/result.
  const touch = () => { setIdemKey(newIdempotencyKey()); setMsg(null); };

  const sameInvoice = fromRef.trim() !== '' && fromRef.trim() === toRef.trim();
  const canPreview = fromRef.trim() !== '' && toRef.trim() !== '' && !sameInvoice;
  const canSubmit = paymentRef.trim() !== '' && canPreview && amount > 0;
  const disabledReason = paymentRef.trim() === '' ? 'Enter the payment reference'
    : fromRef.trim() === '' ? 'Enter the source invoice'
    : toRef.trim() === '' ? 'Enter the target invoice'
    : sameInvoice ? 'Source and target must be different invoices'
    : amount <= 0 ? 'Enter a positive amount to move'
    : undefined;

  const runPreview = async () => {
    if (!canPreview) return;
    setPreviewBusy(true); setMsg(null);
    const read = async (id: string): Promise<number | null> => {
      try { return (await lookupInvoice(id)).outstandingMinor; } catch { return null; }
    };
    const [fromMinor, toMinor] = await Promise.all([read(fromRef.trim()), read(toRef.trim())]);
    setPreview({ fromMinor, toMinor });
    setPreviewBusy(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ ok: boolean }>(
      '/api/billing/reallocate',
      { paymentId: paymentRef.trim(), fromInvoiceId: fromRef.trim(), toInvoiceId: toRef.trim(), amountMinor: amount },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Moved ${money(amount)} from invoice ···${fromRef.trim().slice(-8)} to ···${toRef.trim().slice(-8)}. The correction is recorded and the original entries are preserved.` });
      setAmount(0); setPreview(null); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'reallocation_rejected') {
      setMsg({ tone: 'danger', text: 'Cannot move more than is currently allocated from the source invoice. Nothing changed — your entry is kept; lower the amount or check the source.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing changed — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not reallocate (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Payment reallocation">
      <div className="scr__card" data-testid="realloc-form">
        <h3 className="scr__section-title">Move a payment between invoices (BIL-006)</h3>
        <p className="scr__kpi-meta">Reallocation is append-only — the hub records a reversing entry on the source and a new entry on the target, so nothing is overwritten.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Payment reference" hint="The payment or receipt id" data-testid="realloc-payment" value={paymentRef}
            onChange={(e) => { setPaymentRef(e.currentTarget.value); touch(); }} />
          <Field label="From invoice" hint="Where the payment is now (in error)" data-testid="realloc-from" value={fromRef}
            onChange={(e) => { setFromRef(e.currentTarget.value); setPreview(null); touch(); }} />
          <Field label="To invoice" hint="Where it should go" data-testid="realloc-to" value={toRef}
            onChange={(e) => { setToRef(e.currentTarget.value); setPreview(null); touch(); }} />
          <Field label="Amount to move" numeric prefix="¢" hint="In cents" data-testid="realloc-amount" value={amount} min={1} step={1}
            onChange={(e) => { setAmount(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0))); touch(); }} />
        </div>

        {sameInvoice && (
          <div style={{ marginTop: 'var(--sancta-space-2)' }}>
            <Banner tone="warning" title="Source and target are the same">Choose two different invoices — reallocation moves money from one to another.</Banner>
          </div>
        )}

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="secondary" data-testid="realloc-preview" disabled={previewBusy}
            {...(!canPreview ? { disabledReason: 'Enter two different invoices to preview their balances' } : {})}
            onClick={runPreview}>Preview balances</Button>
          <Button variant="primary" data-testid="realloc-submit" disabled={busy}
            {...(disabledReason ? { disabledReason } : {})}
            onClick={submit}>Reallocate</Button>
        </div>
      </div>

      {preview
        ? (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="realloc-preview-table">
              <caption className="sancta-visually-hidden">Current outstanding balance of the source and target invoices before the move.</caption>
              <thead><tr><th scope="col">Role</th><th scope="col">Invoice</th><th scope="col" style={{ textAlign: 'right' }}>Outstanding now</th></tr></thead>
              <tbody>
                <tr>
                  <td><StatusTag tone="warning" icon="alert">Source</StatusTag></td>
                  <td data-numeric>···{fromRef.trim().slice(-8)}</td>
                  <td data-numeric style={{ textAlign: 'right' }}>{preview.fromMinor === null ? '—' : money(preview.fromMinor)}</td>
                </tr>
                <tr>
                  <td><StatusTag tone="info" icon="info">Target</StatusTag></td>
                  <td data-numeric>···{toRef.trim().slice(-8)}</td>
                  <td data-numeric style={{ textAlign: 'right' }}>{preview.toMinor === null ? '—' : money(preview.toMinor)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
        : <StateBlock state="empty" title="No preview yet">Preview both invoices' balances before moving the payment, or reallocate directly — the hub validates the source has enough allocated.</StateBlock>}

      {msg && <div data-testid="realloc-result"><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
    </section>
  );
}
