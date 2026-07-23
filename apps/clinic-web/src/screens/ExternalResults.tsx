import { useState } from 'react';
import { Banner, Button, Field, StatusTag } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Abnormal = 'normal' | 'low' | 'high' | 'critical';
const ABNORMALS: Array<{ value: Abnormal; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low (abnormal)' },
  { value: 'high', label: 'High (abnormal)' },
  { value: 'critical', label: 'Critical' },
];
function abnormalTone(a: string): 'success' | 'warning' | 'danger' {
  if (a === 'critical') return 'danger';
  if (a === 'normal') return 'success';
  return 'warning';
}

/**
 * External / outside results (ORD-007). Record a result that arrived from another
 * lab or facility. The hub tries to auto-link it to an active order by reference
 * (order code or id); if it cannot, the result lands on the Unmatched queue for
 * manual reconciliation. A critical or abnormal external result is flagged in red
 * so it is never mistaken for a routine value. Recording is a confirmed-commit
 * write (§9.2): success shows only once the hub accepts, and the draft is preserved
 * on any failure. The selected patient (if any) scopes the auto-match.
 */
export function ExternalResults({ patient }: { patient: Patient | null }) {
  const [orderRef, setOrderRef] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [abnormal, setAbnormal] = useState<Abnormal>('normal');
  const [source, setSource] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);

  const canSubmit = orderRef.trim().length > 0;
  const valueNum = value.trim() === '' ? null : Number(value);
  const valueInvalid = value.trim() !== '' && Number.isNaN(valueNum);

  const submit = async () => {
    if (!canSubmit || valueInvalid) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string; matched: boolean; serviceRequestId: string | null }>(
      '/api/orders/external-result',
      {
        orderRef: orderRef.trim(),
        abnormal,
        ...(patient ? { patientId: patient.id } : {}),
        ...(valueNum !== null ? { value: valueNum } : {}),
        ...(unit.trim() ? { unit: unit.trim() } : {}),
        ...(source.trim() ? { source: source.trim() } : {}),
      },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok && res.data?.id) {
      const crit = abnormal === 'critical';
      const matched = res.data.matched;
      setMsg({
        tone: crit ? 'danger' : matched ? 'success' : 'warning',
        text: `${crit ? 'CRITICAL external result recorded. ' : 'External result recorded. '}${matched
          ? `Auto-linked to an active order (result ···${res.data.id.slice(-8)}).`
          : `No matching order — sent to the Unmatched queue for reconciliation (result ···${res.data.id.slice(-8)}).`}`,
      });
      setOrderRef(''); setValue(''); setUnit(''); setSource(''); setAbnormal('normal'); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not record the external result (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="External results">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">External results (ORD-007)</h3>
        <StatusTag tone={abnormalTone(abnormal)} icon={abnormal === 'critical' ? 'alert' : null}>{ABNORMALS.find((a) => a.value === abnormal)!.label}</StatusTag>
      </div>

      <div className="scr__card" data-testid="er-form">
        <p className="scr__kpi-meta">
          Record a result from an outside lab or facility. The hub links it to a matching active order automatically; anything it cannot match goes to the Unmatched queue.
          {patient ? ` Scoped to patient ···${patient.id.slice(-8)}.` : ' No patient in context — matching uses the order reference alone.'}
        </p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Order reference" hint="Order code or id from the request" data-testid="er-order-ref" value={orderRef} onChange={(e) => setOrderRef(e.currentTarget.value)} />
          <Field label="Value" optional numeric hint="Numeric result value" data-testid="er-value" value={value} onChange={(e) => setValue(e.currentTarget.value)}
            {...(valueInvalid ? { error: 'Enter a number' } : {})} />
          <Field label="Unit" optional hint="Unit of measure" data-testid="er-unit" value={unit} onChange={(e) => setUnit(e.currentTarget.value)} />
          <label className="sancta-field">
            <span className="sancta-field__label">Classification</span>
            <select className="sancta-field-input" data-testid="er-abnormal" value={abnormal} onChange={(e) => setAbnormal(e.currentTarget.value as Abnormal)}>
              {ABNORMALS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
          <Field label="Source" optional hint="Originating lab or facility" data-testid="er-source" value={source} onChange={(e) => setSource(e.currentTarget.value)} />
        </div>

        {abnormal === 'critical' && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Banner tone="danger" title="Critical result" assertive>A critical external result needs urgent clinical attention. Once recorded it must be acted on — confirm the value and source before saving.</Banner>
          </div>
        )}

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="er-submit" disabled={busy}
            {...(!canSubmit ? { disabledReason: 'Enter an order reference' } : valueInvalid ? { disabledReason: 'Enter a valid numeric value' } : {})}
            onClick={submit}>Record external result</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
