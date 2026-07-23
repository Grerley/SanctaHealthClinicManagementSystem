import { useState } from 'react';
import { Banner, Button, Field, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';

type SupersedeOut = { documentId: string; version: number };
type EieOut = { status: 'entered_in_error' };

/**
 * Document version & correction control (DOC-003). Two control events on an existing
 * document reference, each operator-driven (no mount-time read, so no uuid scoping):
 *  - Supersede: link a newer document as the current version; the prior one is marked
 *    SUPERSEDED, never removed, so the history stays intact.
 *  - Entered-in-error: a mistaken document is flagged, not deleted, and REQUIRES a
 *    reason. It remains in the record shown as entered-in-error.
 * Both are confirmed-commit writes (§9.2) that keep the draft on failure. Uses POST
 * /api/documents/supersede and /api/documents/entered-in-error — matching path+method
 * on the edge and the Worker.
 */
export function DocumentLifecycle() {
  // --- Supersede ---
  const [supDocId, setSupDocId] = useState('');
  const [supNewId, setSupNewId] = useState('');
  const [supKey, setSupKey] = useState(newIdempotencyKey());
  const [supBusy, setSupBusy] = useState(false);
  const [supMsg, setSupMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // --- Entered-in-error ---
  const [eieDocId, setEieDocId] = useState('');
  const [eieReason, setEieReason] = useState('');
  const [eieKey, setEieKey] = useState(newIdempotencyKey());
  const [eieBusy, setEieBusy] = useState(false);
  const [eieConfirm, setEieConfirm] = useState(false);
  const [eieMsg, setEieMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const supersede = async () => {
    if (!supDocId.trim() || !supNewId.trim()) return;
    setSupBusy(true); setSupMsg(null);
    const res = await mutate<SupersedeOut>(
      '/api/documents/supersede',
      { documentId: supDocId.trim(), newDocumentId: supNewId.trim(), by: BY },
      { idempotencyKey: supKey },
    );
    setSupBusy(false);
    if (res.ok && res.data?.version !== undefined) {
      setSupMsg({ tone: 'success', text: `Superseded. ···${supNewId.trim().slice(-8)} is now the current version (v${res.data.version}); ···${supDocId.trim().slice(-8)} is retained as superseded.` });
      setSupDocId(''); setSupNewId(''); setSupKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setSupMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing changed — your entry is kept; retry when connected.' });
    } else {
      setSupMsg({ tone: 'danger', text: `Could not supersede (${res.errorMessage ?? res.errorCode ?? 'error'}). Only an available document can be superseded. Your entry is kept.` });
    }
  };

  const markEie = async () => {
    if (!eieDocId.trim() || !eieReason.trim()) return;
    setEieBusy(true); setEieMsg(null);
    const res = await mutate<EieOut>(
      '/api/documents/entered-in-error',
      { documentId: eieDocId.trim(), reason: eieReason.trim(), by: BY },
      { idempotencyKey: eieKey },
    );
    setEieBusy(false); setEieConfirm(false);
    if (res.ok && res.data?.status === 'entered_in_error') {
      setEieMsg({ tone: 'success', text: `···${eieDocId.trim().slice(-8)} flagged entered-in-error. It is retained in the record, shown as entered-in-error — it is not deleted.` });
      setEieDocId(''); setEieReason(''); setEieKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setEieMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing changed — your entry is kept; retry when connected.' });
    } else {
      setEieMsg({ tone: 'danger', text: `Could not mark entered-in-error (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Document version and correction">
      <div className="scr__card" data-testid="sup-form">
        <h3 className="scr__section-title">Supersede a version (DOC-03)</h3>
        <p className="scr__kpi-meta">Link a newer document as the current version. The prior version is kept and marked superseded — the history is never lost.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Document to supersede" hint="The existing document reference" data-testid="sup-doc" value={supDocId} onChange={(e) => setSupDocId(e.currentTarget.value)} />
          <Field label="New (current) document" hint="The replacement document reference" data-testid="sup-new" value={supNewId} onChange={(e) => setSupNewId(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="sup-submit" disabled={supBusy}
            {...(!supDocId.trim() ? { disabledReason: 'Enter the document to supersede' } : !supNewId.trim() ? { disabledReason: 'Enter the replacement document' } : {})}
            onClick={supersede}>Supersede</Button>
        </div>
        {supMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={supMsg.tone} assertive={supMsg.tone === 'danger'}>{supMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="eie-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Mark entered-in-error (DOC-03)</h3>
          <StatusTag tone="danger" icon="alert">Control event</StatusTag>
        </div>
        <p className="scr__kpi-meta">A mistaken document is flagged, not deleted. A reason is required and the action is recorded.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Document reference" data-testid="eie-doc" value={eieDocId} onChange={(e) => { setEieDocId(e.currentTarget.value); setEieConfirm(false); }} />
          <Field label="Reason" hint="Why this document is in error" data-testid="eie-reason" value={eieReason} onChange={(e) => { setEieReason(e.currentTarget.value); setEieConfirm(false); }} />
        </div>
        {!eieConfirm
          ? <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
              <Button variant="secondary" tone="danger" data-testid="eie-start" disabled={eieBusy}
                {...(!eieDocId.trim() ? { disabledReason: 'Enter a document reference' } : !eieReason.trim() ? { disabledReason: 'Enter a reason' } : {})}
                onClick={() => setEieConfirm(true)}>Mark entered-in-error…</Button>
            </div>
          : <div style={{ marginTop: 'var(--sancta-space-3)' }}>
              <Banner tone="danger" title={`Flag ···${eieDocId.trim().slice(-8)} as entered-in-error?`} assertive>
                The document stays in the record, shown as entered-in-error, with your reason recorded. This cannot be silently undone.
              </Banner>
              <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
                <Button variant="primary" tone="danger" data-testid="eie-confirm" disabled={eieBusy} onClick={markEie}>Confirm entered-in-error</Button>
                <Button variant="subtle" data-testid="eie-cancel" disabled={eieBusy} onClick={() => setEieConfirm(false)}>Cancel</Button>
              </div>
            </div>}
        {eieMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={eieMsg.tone} assertive={eieMsg.tone === 'danger'}>{eieMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
