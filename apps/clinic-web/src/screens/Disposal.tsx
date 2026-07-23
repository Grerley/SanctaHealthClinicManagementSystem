import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';

type Candidate = { id: string; docType: string; retentionClass: string | null; retainUntil: string };
type DisposeOut = { status: 'disposed' };

/**
 * Disposal schedule (DOC-005). Lists documents past their retain-until date and not on
 * legal hold — the only ones eligible for disposal as-of a chosen date. Disposal is a
 * deliberate control event: it requires an explicit confirmation and a confirmed-commit
 * (§9.2); it never hard-deletes (the reference is retained, marked disposed, with its
 * snapshot cleared). The candidates read is filtered by DATE, not a uuid, so it is safe
 * to load on open. Uses GET /api/documents/disposal-candidates and POST
 * /api/documents/dispose — matching path+method on the edge and the Worker.
 */
export function Disposal() {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [confirm, setConfirm] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (date: string) => {
    const r = await jsonFetch<{ candidates: Candidate[] }>(`/api/documents/disposal-candidates?asOf=${encodeURIComponent(date)}`);
    setCandidates(r.candidates);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(asOf); setState('ready'); } catch { setState('error'); } })();
    // Reload only when the operator applies a new date via the button, not on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const reload = async () => {
    setState('loading'); setMsg(null);
    try { await load(asOf); setState('ready'); } catch { setState('error'); }
  };

  const dispose = async (c: Candidate) => {
    setBusy(true); setMsg(null);
    const res = await mutate<DisposeOut>(
      '/api/documents/dispose',
      { documentId: c.id, asOf, by: BY },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false); setConfirm(null);
    if (res.ok && res.data?.status === 'disposed') {
      setMsg({ tone: 'success', text: `···${c.id.slice(-8)} disposed per retention policy. The reference is retained and marked disposed; its snapshot is cleared.` });
      try { await load(asOf); } catch { /* the state block covers connectivity */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing was disposed. Retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not dispose (${res.errorMessage ?? res.errorCode ?? 'error'}). A held document or one within retention cannot be disposed.` });
    }
  };

  return (
    <section className="scr" aria-label="Disposal schedule">
      <div className="scr__card" data-testid="disp-controls">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Disposal candidates (DOC-05)</h3>
          <StatusTag tone="danger" icon="alert">Disposal is a control event</StatusTag>
        </div>
        <p className="scr__kpi-meta">Documents past their retain-until date and not on legal hold, as of the chosen date.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="As of" type="date" data-testid="disp-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
          <Button variant="secondary" data-testid="disp-reload" disabled={state === 'loading'} onClick={reload}>Show candidates</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      {state === 'loading' && <StateBlock state="initial-loading" title="Loading disposal candidates" />}
      {state === 'error' && <StateBlock state="stale" title="Disposal candidates unavailable">The clinic hub may be unreachable.</StateBlock>}
      {state === 'ready' && (
        candidates.length === 0
          ? <StateBlock state="empty" title="No documents eligible for disposal">Nothing is past retention and off legal hold as of {asOf}.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="disp-list">
                <caption className="sancta-visually-hidden">Documents eligible for disposal as of the chosen date</caption>
                <thead><tr><th scope="col">Reference</th><th scope="col">Type</th><th scope="col">Retention class</th><th scope="col">Retain until</th><th scope="col"></th></tr></thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id} data-selected={confirm?.id === c.id || undefined}>
                      <td data-numeric>···{c.id.slice(-8)}</td>
                      <td>{c.docType}</td>
                      <td>{c.retentionClass ?? '—'}</td>
                      <td data-numeric>{c.retainUntil}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Button variant="secondary" tone="danger" density="compact" data-testid="disp-start" disabled={busy} onClick={() => setConfirm(c)}>Dispose…</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {confirm && (
        <div className="scr__card" data-testid="disp-confirm" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <Banner tone="danger" title={`Dispose ···${confirm.id.slice(-8)} (${confirm.docType})?`} assertive>
            Disposal is permitted because it is past its retain-until date ({confirm.retainUntil}) and not on legal hold. The reference is kept and marked disposed; the snapshot is cleared. This is not a hard delete but it cannot be silently reversed.
          </Banner>
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" tone="danger" data-testid="disp-confirm-btn" disabled={busy} onClick={() => dispose(confirm)}>Confirm disposal</Button>
            <Button variant="subtle" data-testid="disp-cancel" disabled={busy} onClick={() => setConfirm(null)}>Keep document</Button>
          </div>
        </div>
      )}
    </section>
  );
}
