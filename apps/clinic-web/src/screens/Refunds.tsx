import { useState } from 'react';
import { Banner, Button, Field, StatusTag } from '@sancta/ui';
import { money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Method = 'cash' | 'bank' | 'mobile';

// A refund at or above this amount is highlighted as a significant control event so
// the operator names the authorising supervisor deliberately. An approver is ALWAYS
// required (the hub rejects a refund without one); this only changes the emphasis.
const SIGNIFICANT_MINOR = 5000; // $50.00

/**
 * Payment refund (BIL-010). A refund never edits the original payment or receipt: the
 * hub creates a linked refund record with the authorising approver and posts a
 * reversing journal, and it cannot exceed the payment's un-refunded amount. Because a
 * refund moves money out, it is authorised — a named approver and a reason are
 * mandatory here (the UI requires them and the hub enforces them authoritatively), and
 * the refundable ceiling is checked by the hub, not guessed by the screen. Committing
 * is a §9.2 confirmed write: a fresh idempotency key per intent so a retry or queue
 * replay never refunds twice, success shown only on a durable commit, and the entry
 * kept on any failure.
 */
export function Refunds() {
  const [paymentRef, setPaymentRef] = useState('');
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<Method>('cash');
  const [reason, setReason] = useState('');
  const [approver, setApprover] = useState('');

  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const touch = () => { setIdemKey(newIdempotencyKey()); setMsg(null); };
  const significant = amount >= SIGNIFICANT_MINOR;

  const canSubmit = paymentRef.trim() !== '' && amount > 0 && reason.trim() !== '' && approver.trim() !== '';
  const disabledReason = paymentRef.trim() === '' ? 'Enter the payment reference'
    : amount <= 0 ? 'Enter a positive refund amount'
    : reason.trim() === '' ? 'A reason is required to refund'
    : approver.trim() === '' ? 'A supervisor must authorise the refund by name'
    : undefined;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ refundId: string }>(
      '/api/billing/refund',
      { paymentId: paymentRef.trim(), amountMinor: amount, method, reason: reason.trim(), approver: approver.trim() },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.refundId) {
      setMsg({ tone: 'success', text: `Refund of ${money(amount)} authorised by ${approver.trim()} and posted to the ledger. Reference ···${res.data.refundId.slice(-8)}.` });
      setPaymentRef(''); setAmount(0); setReason(''); setApprover(''); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'refund_rejected') {
      setMsg({ tone: 'danger', text: `The hub declined this refund${res.errorMessage ? ` — ${res.errorMessage}` : ''}. Nothing was refunded — your entry is kept.` });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was refunded — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not process the refund (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Payment refund">
      <div className="scr__card" data-testid="refund-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Refund a payment (BIL-010)</h3>
          <StatusTag tone={significant ? 'warning' : 'neutral'} icon={significant ? 'alert' : 'info'}>
            {significant ? 'Significant refund' : 'Authorised refund'}
          </StatusTag>
        </div>
        <p className="scr__kpi-meta">The original receipt is never changed — a linked refund is recorded with the approver and a reversing journal is posted. The hub limits the refund to the payment’s un-refunded amount.</p>

        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Payment reference" hint="The payment or receipt being refunded" data-testid="refund-payment" value={paymentRef}
            onChange={(e) => { setPaymentRef(e.currentTarget.value); touch(); }} />
          <Field label="Refund amount" numeric prefix="¢" hint={amount > 0 ? `= ${money(amount)}` : 'In cents'} data-testid="refund-amount" value={amount} min={1} step={1}
            onChange={(e) => { setAmount(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0))); touch(); }} />
          <label className="sancta-field">
            <span className="sancta-field__label">Method</span>
            <select className="sancta-field-input" data-testid="refund-method" value={method} onChange={(e) => { setMethod(e.target.value as Method); touch(); }}>
              <option value="cash">Cash</option><option value="bank">Bank</option><option value="mobile">Mobile</option>
            </select>
          </label>
          <Field label="Reason" hint="Why the payment is being refunded" data-testid="refund-reason" value={reason}
            onChange={(e) => { setReason(e.currentTarget.value); touch(); }} />
          <Field label="Authorising supervisor" hint="Required — the supervisor approving the refund by name" data-testid="refund-approver" value={approver}
            onChange={(e) => { setApprover(e.currentTarget.value); touch(); }} />
        </div>

        {significant && (
          <div style={{ marginTop: 'var(--sancta-space-2)' }}>
            <Banner tone="warning" title="Significant refund">This refund is {money(amount)}. Confirm the supervisor named above has authorised it — the entry is recorded against their name.</Banner>
          </div>
        )}

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone="danger" data-testid="refund-submit" disabled={busy}
            {...(disabledReason ? { disabledReason } : {})}
            onClick={submit}>Process refund</Button>
          <span className="scr__kpi-meta">The hub confirms the amount is refundable before anything is posted.</span>
        </div>

        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }} data-testid="refund-result"><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
