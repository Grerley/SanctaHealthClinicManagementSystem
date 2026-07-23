import { useState } from 'react';
import { Banner, Button, Field, Icon } from '@sancta/ui';
import { money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

function parseMinor(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Claims (BIL-011). Submitting a claim raises it against a covered invoice for the
 * outstanding balance (or a capped amount); adjudicating records the payer's
 * remittance — accept/pay settles the paid portion through the payment path and
 * writes off the disallowed remainder, reject leaves the balance with the patient.
 * Both are confirmed-commit writes (§9.2): the draft is preserved on failure and a
 * fresh idempotency key is minted only after a durable commit.
 */
export function PayerClaims() {
  // Submit draft.
  const [claimNumber, setClaimNumber] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [coverageId, setCoverageId] = useState('');
  const [amountMinor, setAmountMinor] = useState('');
  const [subIdem, setSubIdem] = useState(newIdempotencyKey());
  const [submitting, setSubmitting] = useState(false);
  const [subMsg, setSubMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Adjudicate draft.
  const [claimId, setClaimId] = useState('');
  const [paidMinor, setPaidMinor] = useState('');
  const [reason, setReason] = useState('');
  const [adjIdem, setAdjIdem] = useState(newIdempotencyKey());
  const [deciding, setDeciding] = useState(false);
  const [adjMsg, setAdjMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const submit = async () => {
    if (claimNumber.trim() === '' || invoiceId.trim() === '' || coverageId.trim() === '') return;
    const amt = amountMinor.trim();
    if (amt !== '' && parseMinor(amt) === null) { setSubMsg({ tone: 'danger', text: 'Claim amount must be a whole number of minor units (cents).' }); return; }
    setSubmitting(true); setSubMsg(null);
    const res = await mutate<{ id: string; submittedMinor: number }>(
      '/api/payer/claim',
      {
        claimNumber: claimNumber.trim(),
        invoiceId: invoiceId.trim(),
        coverageId: coverageId.trim(),
        ...(amt ? { amountMinor: Number(amt) } : {}),
      },
      { idempotencyKey: subIdem },
    );
    setSubmitting(false);
    if (res.ok && res.data?.id) {
      setSubMsg({ tone: 'success', text: `Claim ${claimNumber.trim()} submitted for ${money(res.data.submittedMinor)}. Claim id ···${res.data.id.slice(-8)}.` });
      setClaimNumber(''); setInvoiceId(''); setCoverageId(''); setAmountMinor(''); setSubIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setSubMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setSubMsg({ tone: 'danger', text: `Could not submit the claim (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const adjudicate = async (accept: boolean) => {
    if (claimId.trim() === '') return;
    const paid = paidMinor.trim();
    if (accept && paid !== '' && parseMinor(paid) === null) { setAdjMsg({ tone: 'danger', text: 'Paid amount must be a whole number of minor units (cents).' }); return; }
    setDeciding(true); setAdjMsg(null);
    const res = await mutate<{ status: 'paid' | 'accepted' | 'rejected'; paidMinor: number; adjustmentMinor: number }>(
      '/api/payer/claim/adjudicate',
      {
        claimId: claimId.trim(),
        accept,
        ...(accept && paid ? { paidMinor: Number(paid) } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      { idempotencyKey: adjIdem },
    );
    setDeciding(false);
    if (res.ok && res.data?.status) {
      const d = res.data;
      setAdjMsg({ tone: 'success', text: `Claim ···${claimId.trim().slice(-8)} ${d.status} — paid ${money(d.paidMinor)}, adjustment ${money(d.adjustmentMinor)}.` });
      setClaimId(''); setPaidMinor(''); setReason(''); setAdjIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setAdjMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setAdjMsg({ tone: 'danger', text: `Could not adjudicate the claim (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Payer claims">
      <div className="scr__card" data-testid="payer-claim-form">
        <h3 className="scr__section-title">Submit a claim</h3>
        <p className="scr__kpi-meta">Raise a claim against a covered invoice. Leave the amount blank to claim the invoice's full outstanding balance, or cap it to a lower amount. Amounts are in minor units (cents).</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Claim number" hint="Your reference for this claim" data-testid="payer-claim-number" value={claimNumber} onChange={(e) => setClaimNumber(e.currentTarget.value)} />
          <Field label="Invoice id" hint="The invoice being claimed" data-testid="payer-claim-invoice" value={invoiceId} onChange={(e) => setInvoiceId(e.currentTarget.value)} />
          <Field label="Coverage id" hint="The active coverage to bill" data-testid="payer-claim-coverage" value={coverageId} onChange={(e) => setCoverageId(e.currentTarget.value)} />
          <Field label="Amount" optional numeric suffix="minor units" hint="Blank claims the full outstanding" data-testid="payer-claim-amount" value={amountMinor} onChange={(e) => setAmountMinor(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="payer-claim-submit" disabled={submitting}
            {...(claimNumber.trim() === '' ? { disabledReason: 'Enter the claim number' }
              : invoiceId.trim() === '' ? { disabledReason: 'Enter the invoice id' }
              : coverageId.trim() === '' ? { disabledReason: 'Enter the coverage id' } : {})}
            onClick={submit}>Submit claim</Button>
        </div>
        {subMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={subMsg.tone} assertive={subMsg.tone === 'danger'}>{subMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="payer-adjudicate-form">
        <h3 className="scr__section-title">Adjudicate a claim</h3>
        <p className="scr__kpi-meta">Record the payer's remittance. Accept/pay settles the paid portion through the payment path and writes off the disallowed remainder; reject records the reason and leaves the balance with the patient. Leave paid blank to pay the full submitted amount.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Claim id" hint="The submitted claim" data-testid="payer-adj-claim" value={claimId} onChange={(e) => setClaimId(e.currentTarget.value)} />
          <Field label="Paid amount" optional numeric suffix="minor units" hint="For accept/pay; blank pays in full" data-testid="payer-adj-paid" value={paidMinor} onChange={(e) => setPaidMinor(e.currentTarget.value)} />
          <Field label="Reason" optional hint="Remittance note or rejection reason" data-testid="payer-adj-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)', gap: 'var(--sancta-space-2)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="payer-adj-accept" disabled={deciding}
            {...(claimId.trim() === '' ? { disabledReason: 'Enter the claim id' } : {})}
            onClick={() => void adjudicate(true)}>Accept / pay</Button>
          <Button variant="secondary" tone="danger" icon={<Icon name="alert" />} data-testid="payer-adj-reject" disabled={deciding}
            {...(claimId.trim() === '' ? { disabledReason: 'Enter the claim id' } : {})}
            onClick={() => void adjudicate(false)}>Reject</Button>
        </div>
        {adjMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={adjMsg.tone} assertive={adjMsg.tone === 'danger'}>{adjMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
