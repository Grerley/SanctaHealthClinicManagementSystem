import { useState } from 'react';
import { Banner, Button, Field, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';

type LegalHoldOut = { documentId: string; legalHold: boolean };

/**
 * Legal hold on a document (DOC-003/005). Applying a hold freezes the document against
 * disposal until the hold is lifted — a deliberate control event that requires an
 * explicit intent and a confirmed-commit (§9.2). Operator-driven by document reference,
 * so there is no mount-time uuid read. Uses POST /api/documents/legal-hold — matching
 * path+method on the edge and the Worker.
 */
export function LegalHold() {
  const [docId, setDocId] = useState('');
  const [intent, setIntent] = useState<'apply' | 'lift' | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const commit = async (hold: boolean) => {
    if (!docId.trim()) return;
    setBusy(true); setMsg(null);
    const res = await mutate<LegalHoldOut>(
      '/api/documents/legal-hold',
      { documentId: docId.trim(), hold, by: BY },
      { idempotencyKey: idemKey },
    );
    setBusy(false); setIntent(null);
    if (res.ok && res.data?.legalHold === hold) {
      setMsg({ tone: 'success', text: hold
        ? `Legal hold applied to ···${docId.trim().slice(-8)}. It is now frozen against disposal until the hold is lifted.`
        : `Legal hold lifted from ···${docId.trim().slice(-8)}. It follows the normal retention schedule again.` });
      setDocId(''); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing changed — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not update the legal hold (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Legal hold">
      <div className="scr__card" data-testid="hold-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Legal hold (DOC-05)</h3>
          <StatusTag tone="warning" icon="lock">Control event</StatusTag>
        </div>
        <p className="scr__kpi-meta">A held document cannot be disposed, regardless of its retention date, until the hold is lifted.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Document reference" hint="The document to hold or release" data-testid="hold-doc" value={docId} onChange={(e) => { setDocId(e.currentTarget.value); setIntent(null); }} style={{ minWidth: 280 }} />
        </div>

        {!intent
          ? <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
              <Button variant="primary" data-testid="hold-apply-start" disabled={busy}
                {...(!docId.trim() ? { disabledReason: 'Enter a document reference' } : {})}
                onClick={() => setIntent('apply')}>Apply hold…</Button>
              <Button variant="secondary" data-testid="hold-lift-start" disabled={busy}
                {...(!docId.trim() ? { disabledReason: 'Enter a document reference' } : {})}
                onClick={() => setIntent('lift')}>Lift hold…</Button>
            </div>
          : <div style={{ marginTop: 'var(--sancta-space-3)' }}>
              <Banner tone={intent === 'apply' ? 'warning' : 'info'} title={intent === 'apply' ? `Apply a legal hold to ···${docId.trim().slice(-8)}?` : `Lift the legal hold on ···${docId.trim().slice(-8)}?`} assertive>
                {intent === 'apply'
                  ? 'While held, this document is protected from disposal even after its retain-until date. The action is recorded.'
                  : 'Once lifted, this document can be disposed after its retain-until date. The action is recorded.'}
              </Banner>
              <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
                <Button variant="primary" tone="action" data-testid="hold-confirm" disabled={busy} onClick={() => commit(intent === 'apply')}>
                  {intent === 'apply' ? 'Confirm hold' : 'Confirm lift'}
                </Button>
                <Button variant="subtle" data-testid="hold-cancel" disabled={busy} onClick={() => setIntent(null)}>Cancel</Button>
              </div>
            </div>}
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
