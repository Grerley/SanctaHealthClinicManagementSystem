import { useState } from 'react';
import { Banner, Button, Field, Icon } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * Payer registry (BIL-011). Registers a third-party payer / insurance scheme into
 * the billing master so coverage, pre-authorisations and claims can reference it.
 * There is no list endpoint for payers, so this is a single confirmed-commit write
 * (§9.2): the draft is preserved on failure and a fresh idempotency key is minted
 * only after a durable commit.
 */
export function PayerRegistry() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const register = async () => {
    if (code.trim() === '' || name.trim() === '') return;
    setSaving(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/payer/register',
      { code: code.trim(), name: name.trim() },
      { idempotencyKey: idem },
    );
    setSaving(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `Registered ${name.trim()} (${code.trim()}). Payer id ···${res.data.id.slice(-8)}.` });
      setCode(''); setName(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not register the payer (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Payer registry">
      <div className="scr__card" data-testid="payer-register-form">
        <h3 className="scr__section-title">Register a payer</h3>
        <p className="scr__kpi-meta">Add an insurance scheme or third-party payer to the billing master. The code is the short reference used on coverage and claims; the name is what appears on statements.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Payer code" hint="Short unique reference" data-testid="payer-reg-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Payer name" hint="Scheme or insurer name" data-testid="payer-reg-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="payer-reg-submit" disabled={saving}
            {...(code.trim() === '' ? { disabledReason: 'Enter the payer code' } : name.trim() === '' ? { disabledReason: 'Enter the payer name' } : {})}
            onClick={register}>Register payer</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
