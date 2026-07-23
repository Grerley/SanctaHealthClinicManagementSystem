import { useState } from 'react';
import { Banner, Button, Field, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';

type RetentionOut = { documentId: string };

const CLASSES = ['clinical-10y', 'financial-7y', 'admin-3y', 'consent-permanent', 'imaging-8y'];

/**
 * Retention schedule (DOC-005). Assign a retention class and the retain-until date that
 * governs when a document becomes eligible for disposal. Setting retention is a
 * confirmed-commit write (§9.2), operator-driven by document reference (no mount-time
 * uuid read), with the draft kept on failure. Uses POST /api/documents/retention —
 * matching path+method on the edge and the Worker.
 */
export function Retention() {
  const [docId, setDocId] = useState('');
  const [retentionClass, setRetentionClass] = useState('');
  const [retainUntil, setRetainUntil] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const canSubmit = docId.trim() !== '' && retentionClass.trim() !== '' && retainUntil.trim() !== '';

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<RetentionOut>(
      '/api/documents/retention',
      { documentId: docId.trim(), retentionClass: retentionClass.trim(), retainUntil: retainUntil.trim(), by: BY },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.documentId) {
      setMsg({ tone: 'success', text: `Retention set on ···${docId.trim().slice(-8)}: ${retentionClass.trim()}, retain until ${retainUntil.trim()}. It becomes eligible for disposal only after that date, and never while on legal hold.` });
      setDocId(''); setRetentionClass(''); setRetainUntil(''); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was set — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not set retention (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Retention schedule">
      <div className="scr__card" data-testid="ret-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Retention schedule (DOC-05)</h3>
          <StatusTag tone="neutral" icon="info">Governs disposal eligibility</StatusTag>
        </div>
        <p className="scr__kpi-meta">The retain-until date is the earliest a document may be disposed. Disposal is still refused while a legal hold is in force.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Document reference" hint="The document to schedule" data-testid="ret-doc" value={docId} onChange={(e) => setDocId(e.currentTarget.value)} />
          <label className="sancta-field">
            <span className="sancta-field__label">Retention class</span>
            <span className="sancta-field__hint">Choose a class or type your own</span>
            <input className="sancta-field-input" list="ret-class-list" data-testid="ret-class" value={retentionClass} onChange={(e) => setRetentionClass(e.currentTarget.value)} />
            <datalist id="ret-class-list">{CLASSES.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <Field label="Retain until" type="date" data-testid="ret-until" value={retainUntil} onChange={(e) => setRetainUntil(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="ret-submit" disabled={busy}
            {...(!docId.trim() ? { disabledReason: 'Enter a document reference' } : !retentionClass.trim() ? { disabledReason: 'Enter a retention class' } : !retainUntil.trim() ? { disabledReason: 'Enter a retain-until date' } : {})}
            onClick={submit}>Set retention</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
