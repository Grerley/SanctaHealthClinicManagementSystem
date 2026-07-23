import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const ORDERED_BY = 'demo-operator';

type Category = 'laboratory' | 'imaging' | 'procedure' | 'referral';
type Priority = 'routine' | 'urgent' | 'stat';
const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: 'laboratory', label: 'Laboratory' },
  { value: 'imaging', label: 'Imaging' },
  { value: 'procedure', label: 'Procedure' },
  { value: 'referral', label: 'Referral' },
];
const PRIORITIES: Array<{ value: Priority; label: string }> = [
  { value: 'routine', label: 'Routine' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'stat', label: 'STAT (immediate)' },
];
const PRIORITY_TONE: Record<Priority, 'neutral' | 'warning' | 'danger'> = { routine: 'neutral', urgent: 'warning', stat: 'danger' };

/**
 * Order entry (ORD-01) for the patient in context. Places a structured request
 * (category + code + clinical indication) so the result can later be reconciled to
 * its order and — when abnormal — surfaced as a critical result in the Inbox
 * (ORD-07). Placing an order is a confirmed-commit write (§9.2): success shows only
 * once the hub accepts it, and the draft is preserved on any failure. An indication
 * is required, so no order is placed without a clinical reason. Opens only with a
 * patient in context; no load-time fetch.
 */
export function Orders({ patient }: { patient: Patient | null }) {
  const [category, setCategory] = useState<Category>('laboratory');
  const [code, setCode] = useState('');
  const [priority, setPriority] = useState<Priority>('routine');
  const [indication, setIndication] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  if (!patient) {
    return <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to place an order. Every request is attributed to a named patient.</StateBlock>;
  }

  const canSubmit = code.trim().length > 0 && indication.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ orderId: string }>(
      '/api/orders',
      { patientId: patient.id, category, code: code.trim(), priority, indication: indication.trim(), requestedBy: ORDERED_BY },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.orderId) {
      setMsg({ tone: priority === 'routine' ? 'success' : 'warning',
        text: `${priority === 'stat' ? 'STAT ' : priority === 'urgent' ? 'Urgent ' : ''}order placed and saved to the clinic. Order ···${res.data.orderId.slice(-8)}.` });
      setCode(''); setIndication(''); setPriority('routine'); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was ordered — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not place the order (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Order entry">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Place an order (ORD-01)</h3>
        <StatusTag tone={PRIORITY_TONE[priority]} icon={priority === 'stat' ? 'alert' : null}>
          {PRIORITIES.find((x) => x.value === priority)!.label}
        </StatusTag>
      </div>

      <div className="scr__card" data-testid="ord-form">
        <div className="scr__form-grid">
          <label className="sancta-field">
            <span className="sancta-field__label">Category</span>
            <select className="sancta-field-input" data-testid="ord-category" value={category} onChange={(e) => setCategory(e.currentTarget.value as Category)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <Field label="Order code" hint="Test, study or procedure code" data-testid="ord-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <label className="sancta-field">
            <span className="sancta-field__label">Priority</span>
            <select className="sancta-field-input" data-testid="ord-priority" value={priority} onChange={(e) => setPriority(e.currentTarget.value as Priority)}>
              {PRIORITIES.map((pr) => <option key={pr.value} value={pr.value}>{pr.label}</option>)}
            </select>
          </label>
          <Field label="Clinical indication" hint="Required — the reason for the request" data-testid="ord-indication" value={indication} onChange={(e) => setIndication(e.currentTarget.value)} />
        </div>

        {priority === 'stat' && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Banner tone="warning" title="STAT order">A STAT order signals an immediate turnaround is required. Confirm the code and indication are correct before placing it.</Banner>
          </div>
        )}

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="ord-submit" disabled={busy}
            {...(!canSubmit ? { disabledReason: 'Enter an order code and a clinical indication' } : {})}
            onClick={submit}>Place order</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
