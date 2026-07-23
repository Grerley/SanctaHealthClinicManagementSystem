import { useState } from 'react';
import { Banner, Button, Field, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

function isoToday(): string { return new Date().toISOString().slice(0, 10); }

type SpecimenLabel = { accession: string; line1: string; line2: string; line3: string };

/**
 * Patient-safe specimen labels (ORD-004). Allocating a label assigns a gapless
 * accession to an order and prints a positive-identification set — accession +
 * order code, initials + DOB + sex, collection date — but NEVER the patient's full
 * name or full record number, so a label seen at the bench cannot leak identity.
 * Generating a label is a confirmed-commit write (§9.2): the accession is only
 * consumed once the hub accepts, and the draft is preserved on any failure. The
 * returned label is rendered but carries no full identifiers.
 */
export function SpecimenLabels() {
  const [orderId, setOrderId] = useState('');
  const [collectedOn, setCollectedOn] = useState(isoToday());
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState<SpecimenLabel | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const canSubmit = orderId.trim().length > 0 && collectedOn.trim().length > 0;

  const generate = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<SpecimenLabel>(
      '/api/orders/specimen-label',
      { orderId: orderId.trim(), ...(collectedOn.trim() ? { collectedOn } : {}) },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok && res.data?.accession) {
      setLabel(res.data);
      setMsg({ tone: 'success', text: `Label ${res.data.accession} allocated for order ···${orderId.trim().slice(-8)}.` });
      setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setLabel(null);
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setLabel(null);
      setMsg({ tone: 'danger', text: `Could not generate the label (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Specimen labels">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Specimen labels (ORD-004)</h3>
        <StatusTag tone="info" icon="info">Identity-safe: no full name on labels</StatusTag>
      </div>

      <div className="scr__card" data-testid="sl-form">
        <p className="scr__kpi-meta">Allocate a specimen label for an order. The label carries the accession, order code, initials, date of birth and sex — enough for positive identification at the bench, but never the full name.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Order id" hint="The order the specimen belongs to" data-testid="sl-order-id" value={orderId} onChange={(e) => setOrderId(e.currentTarget.value)} />
          <Field label="Collected on" type="date" hint="Date the specimen was collected" data-testid="sl-collected" value={collectedOn} onChange={(e) => setCollectedOn(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="sl-submit" disabled={busy}
            {...(!canSubmit ? { disabledReason: 'Enter the order id and collection date' } : {})}
            onClick={generate}>Generate label</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      {label && (
        <div className="scr__card" data-testid="sl-label">
          <h3 className="scr__section-title">Allocated label</h3>
          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-2)' }}>
            <table className="scr__table" data-testid="sl-label-table">
              <caption className="sancta-visually-hidden">The allocated specimen label lines. Positive identification only — no full name.</caption>
              <thead><tr><th scope="col">Accession</th><th scope="col">Order</th><th scope="col">Patient (initials · DOB · sex)</th><th scope="col">Collection</th></tr></thead>
              <tbody>
                <tr>
                  <td data-numeric><StatusTag tone="action" icon={null}>{label.accession}</StatusTag></td>
                  <td>{label.line1}</td>
                  <td>{label.line2}</td>
                  <td>{label.line3}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
