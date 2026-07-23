import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const USER = 'demo-operator';

type DisclosureRow = { userId: string; purpose: string | null; disclosedAt: string };
type OpenOut = { filename: string; mimeType: string; sha256: string; securityLabel: string };

/**
 * Disclosures & access log (DOC-004/007). Opening a sensitive or restricted document
 * records an auditable disclosure; this screen both performs an access (open, which
 * records the disclosure when the label is not normal) and reads the disclosure log for
 * a document. Both are operator-driven by document reference — no mount-time uuid read.
 * Opening is a confirmed-commit write (§9.2). The log GET is sent with BOTH `documentId`
 * and `id` query keys because the Worker reads `documentId` while the edge reads `id`
 * for the same route+method — so one request works against either backend. Uses POST
 * /api/documents/open and GET /api/documents/disclosures.
 */
export function Disclosures() {
  // --- Open (record an access) ---
  const [openDocId, setOpenDocId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [openKey, setOpenKey] = useState(newIdempotencyKey());
  const [openBusy, setOpenBusy] = useState(false);
  const [openMsg, setOpenMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);

  // --- Disclosure log ---
  const [logDocId, setLogDocId] = useState('');
  const [rows, setRows] = useState<DisclosureRow[] | null>(null);
  const [logState, setLogState] = useState<'idle' | 'loading' | 'error'>('idle');

  const openDocument = async () => {
    if (!openDocId.trim()) return;
    setOpenBusy(true); setOpenMsg(null);
    const res = await mutate<OpenOut>(
      '/api/documents/open',
      { documentId: openDocId.trim(), userId: USER, ...(purpose.trim() ? { purpose: purpose.trim() } : {}) },
      { idempotencyKey: openKey },
    );
    setOpenBusy(false);
    if (res.ok && res.data?.filename) {
      const label = res.data.securityLabel;
      setOpenMsg(label === 'normal'
        ? { tone: 'success', text: `Opened ${res.data.filename} (normal). No disclosure is recorded for a normal-label document.` }
        : { tone: 'warning', text: `Opened ${res.data.filename} (${label}). A disclosure has been recorded against this access.` });
      setOpenKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setOpenMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was opened — retry when connected.' });
    } else {
      setOpenMsg({ tone: 'danger', text: `Could not open the document (${res.errorMessage ?? res.errorCode ?? 'error'}). A quarantined or missing document cannot be opened.` });
    }
  };

  const viewLog = async () => {
    if (!logDocId.trim()) return;
    setLogState('loading'); setRows(null);
    const ref = encodeURIComponent(logDocId.trim());
    try {
      const r = await jsonFetch<{ disclosures: DisclosureRow[] }>(`/api/documents/disclosures?documentId=${ref}&id=${ref}`);
      setRows(r.disclosures); setLogState('idle');
    } catch {
      setLogState('error');
    }
  };

  return (
    <section className="scr" aria-label="Disclosures and access log">
      <div className="scr__card" data-testid="open-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Open a document (DOC-07)</h3>
          <StatusTag tone="warning" icon="lock">Sensitive access is disclosed</StatusTag>
        </div>
        <p className="scr__kpi-meta">Opening a sensitive or restricted document records a disclosure with your purpose. A quarantined document cannot be opened.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Document reference" data-testid="open-doc" value={openDocId} onChange={(e) => setOpenDocId(e.currentTarget.value)} />
          <Field label="Purpose of access" optional hint="Recorded on the disclosure" data-testid="open-purpose" value={purpose} onChange={(e) => setPurpose(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="open-submit" disabled={openBusy}
            {...(!openDocId.trim() ? { disabledReason: 'Enter a document reference' } : {})}
            onClick={openDocument}>Open document</Button>
        </div>
        {openMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={openMsg.tone} assertive={openMsg.tone === 'danger'}>{openMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="log-form">
        <h3 className="scr__section-title">Disclosure log (DOC-07)</h3>
        <p className="scr__kpi-meta">Who accessed a sensitive document, for what purpose, and when.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Document reference" data-testid="log-doc" value={logDocId} onChange={(e) => setLogDocId(e.currentTarget.value)} style={{ minWidth: 280 }}
            onKeyDown={(e) => { if (e.key === 'Enter') void viewLog(); }} />
          <Button variant="secondary" data-testid="log-view" disabled={logState === 'loading'}
            {...(!logDocId.trim() ? { disabledReason: 'Enter a document reference' } : {})}
            onClick={viewLog}>View disclosures</Button>
        </div>

        {logState === 'loading' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="initial-loading" title="Loading disclosures" /></div>}
        {logState === 'error' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="stale" title="Disclosure log unavailable">The clinic hub may be unreachable, or the reference is not a valid document id.</StateBlock></div>}
        {logState === 'idle' && rows !== null && (
          rows.length === 0
            ? <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="empty" title="No disclosures recorded">This document has no recorded sensitive accesses.</StateBlock></div>
            : (
              <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
                <table className="scr__table" data-testid="log-list">
                  <caption className="sancta-visually-hidden">Recorded disclosures for the document</caption>
                  <thead><tr><th scope="col">User</th><th scope="col">Purpose</th><th scope="col">Disclosed at</th></tr></thead>
                  <tbody>
                    {rows.map((d, i) => (
                      <tr key={`${d.userId}-${d.disclosedAt}-${i}`}>
                        <td>{d.userId}</td>
                        <td>{d.purpose ?? '—'}</td>
                        <td data-numeric>{d.disclosedAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
    </section>
  );
}
