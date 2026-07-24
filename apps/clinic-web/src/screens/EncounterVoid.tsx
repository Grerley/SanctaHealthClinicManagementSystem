import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';

/**
 * Void an encounter (CLR-004). Marks a signed encounter entered-in-error. This never
 * deletes the record — the encounter and its content are retained and flagged, with a
 * mandatory reason for the audit trail. Confirmed-commit write (§9.2).
 */
export function EncounterVoid() {
  const [encounterId, setEncounterId] = useState('');
  const [reason, setReason] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const ready = encounterId.trim() !== '' && reason.trim() !== '';

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ status: 'entered_in_error' }>(
      '/api/encounters/entered-in-error',
      { encounterId: encounterId.trim(), reason: reason.trim(), user: BY },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Encounter ···${encounterId.trim().slice(-8)} marked entered-in-error. The record is retained, not deleted.` });
      setEncounterId(''); setReason(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not void the encounter (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Void encounter">
      <div className="scr__card" data-testid="encounter-void-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Mark entered-in-error</h3>
          <StatusTag tone="danger" icon="alert">Retained, not deleted</StatusTag>
        </div>
        <p className="scr__kpi-meta">Use this only when an encounter was recorded in error. The content stays on file, flagged as entered-in-error, with the reason recorded for audit.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Encounter id" hint="The encounter to void" data-testid="encounter-void-id" value={encounterId} onChange={(e) => setEncounterId(e.currentTarget.value)} />
          <Field label="Reason" hint="Why it was recorded in error" data-testid="encounter-void-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone="danger" icon={<Icon name="alert" />} data-testid="encounter-void-submit" disabled={busy}
            {...(encounterId.trim() === '' ? { disabledReason: 'Enter the encounter id' } : reason.trim() === '' ? { disabledReason: 'Enter a reason' } : {})}
            onClick={submit}>Mark entered-in-error</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
