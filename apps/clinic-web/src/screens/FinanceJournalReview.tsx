import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';
type Journal = { id: string; memo: string; status: string; periodId: string; makerId: string; checkerId: string | null; batchId: string | null };

/**
 * Manual journal review (FIN-007). Maker-checker: a drafted journal must be approved
 * (posted) or rejected by a different person, with a reason on rejection. Posting and
 * rejecting are confirmed-commit writes (§9.2); the list reloads after each decision.
 */
export function FinanceJournalReview() {
  const [rows, setRows] = useState<Journal[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try { const r = await jsonFetch<{ journals: Journal[] }>('/api/finance/journal?status=drafted'); setRows(r.journals); setState('ready'); }
    catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const post = async (journalId: string) => {
    setBusy(journalId); setMsg(null);
    const res = await mutate<{ status: string }>('/api/finance/journal/post', { journalId, checker: BY }, { idempotencyKey: newIdempotencyKey() });
    setBusy(null);
    if (res.ok) { setMsg({ tone: 'success', text: `Posted journal ···${journalId.slice(-8)}.` }); try { await load(); } catch { /* covered */ } }
    else if (res.errorCode === 'network') setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected.' });
    else setMsg({ tone: 'danger', text: `Could not post the journal (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}).` });
  };

  const reject = async () => {
    if (rejectId.trim() === '' || reason.trim() === '') return;
    setBusy(rejectId); setMsg(null);
    const res = await mutate<{ status: string }>('/api/finance/journal/reject', { journalId: rejectId.trim(), checker: BY, reason: reason.trim() }, { idempotencyKey: newIdempotencyKey() });
    setBusy(null);
    if (res.ok) { setMsg({ tone: 'success', text: `Rejected journal ···${rejectId.trim().slice(-8)}.` }); setRejectId(''); setReason(''); try { await load(); } catch { /* covered */ } }
    else if (res.errorCode === 'network') setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected.' });
    else setMsg({ tone: 'danger', text: `Could not reject the journal (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}).` });
  };

  return (
    <section className="scr" aria-label="Journal review">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Drafted journals</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="journal-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          <StatusTag tone={rows.length > 0 ? 'warning' : 'success'} icon={rows.length > 0 ? 'alert' : 'check'}>{rows.length > 0 ? `${rows.length} awaiting` : 'None awaiting'}</StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading journals" />}
        {state === 'error' && <StateBlock state="stale" title="Journals unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          rows.length === 0
            ? <StateBlock state="empty" title="Nothing to review">No journals are awaiting a checker.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="journal-list">
                  <caption className="sancta-visually-hidden">Drafted manual journals awaiting a checker</caption>
                  <thead><tr><th scope="col">Journal</th><th scope="col">Memo</th><th scope="col">Period</th><th scope="col">Maker</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {rows.map((j) => (
                      <tr key={j.id}>
                        <td data-numeric>···{j.id.slice(-8)}</td>
                        <td>{j.memo}</td>
                        <td data-numeric>{j.periodId}</td>
                        <td data-numeric>···{j.makerId.slice(-8)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div className="scr__row" style={{ justifyContent: 'flex-end' }}>
                            <Button variant="primary" density="compact" data-testid={`journal-post-${j.id.slice(-8)}`} disabled={busy === j.id} onClick={() => post(j.id)}>Post</Button>
                            <Button variant="subtle" tone="danger" density="compact" data-testid={`journal-reject-${j.id.slice(-8)}`} onClick={() => { setRejectId(j.id); setMsg(null); }}>Reject…</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="journal-reject-form">
        <h3 className="scr__section-title">Reject a journal</h3>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Journal id" hint="Pick 'Reject…' above, or paste" data-testid="journal-reject-id" value={rejectId} onChange={(e) => setRejectId(e.currentTarget.value)} />
          <Field label="Reason" hint="Why it is rejected" data-testid="journal-reject-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone="danger" icon={<Icon name="alert" />} data-testid="journal-reject-submit" disabled={busy === rejectId && rejectId !== ''}
            {...(rejectId.trim() === '' ? { disabledReason: 'Choose a journal' } : reason.trim() === '' ? { disabledReason: 'Enter a reason' } : {})}
            onClick={reject}>Reject journal</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
