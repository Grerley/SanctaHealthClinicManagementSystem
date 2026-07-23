import { useState } from 'react';
import { Banner, Button, Field, Icon } from '@sancta/ui';
import { money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const mask = (v: string): string => `···${v.slice(-8)}`;

/**
 * Record a self-service payment intent (COM-006). Authenticated by the patient's
 * portal access token, this only signals an intent to pay — it creates a PENDING
 * intent that a cashier later reconciles to a real payment; it never posts money.
 * A confirmed-commit write (§9.2): the draft is preserved on failure. The amount is
 * entered in major units and sent in minor units. The token is sensitive — never
 * shown in full, never logged, never placed in a test id.
 */
export function SelfServicePayIntent() {
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const [note, setNote] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const amountMinor = Math.round(Number(amount) * 100);
  const amountValid = amount.trim() !== '' && Number.isFinite(amountMinor) && amountMinor > 0;

  const submit = async () => {
    if (token.trim() === '' || !amountValid) return;
    setSaving(true); setMsg(null);
    const res = await mutate<{ id: string; status: string }>(
      '/api/selfservice/pay-intent',
      {
        token: token.trim(),
        amountMinor,
        ...(method.trim() ? { method: method.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      { idempotencyKey: idem },
    );
    setSaving(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `Payment intent ${mask(res.data.id)} for ${money(amountMinor)} recorded as ${res.data.status ?? 'pending'}. A cashier will reconcile it.` });
      setAmount(''); setMethod(''); setNote(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not record the payment intent (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Self-service payment intent">
      <div className="scr__card" data-testid="ss-pay-intent-form">
        <h3 className="scr__section-title">Record a payment intent (COM-006)</h3>
        <p className="scr__kpi-meta">Signals that a patient intends to pay through the portal. It does not post a payment — a cashier reconciles the pending intent against a real receipt. The access token is not stored on this screen or shown in full.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Access token" type="password" hint="The patient's portal access token" data-testid="ss-pay-intent-token" value={token} onChange={(e) => setToken(e.currentTarget.value)} />
          <Field label="Amount" numeric prefix="$" hint="Amount the patient intends to pay" data-testid="ss-pay-intent-amount" value={amount} onChange={(e) => setAmount(e.currentTarget.value)}
            {...(amount.trim() !== '' && !amountValid ? { error: 'Enter an amount greater than zero' } : {})} />
          <Field label="Method" optional hint="e.g. mobile, card" data-testid="ss-pay-intent-method" value={method} onChange={(e) => setMethod(e.currentTarget.value)} />
          <Field label="Note" optional hint="Reference the patient added" data-testid="ss-pay-intent-note" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="ss-pay-intent-submit" disabled={saving}
            {...(token.trim() === '' ? { disabledReason: 'Enter the patient access token' } : !amountValid ? { disabledReason: 'Enter an amount greater than zero' } : {})}
            onClick={submit}>Record intent</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
