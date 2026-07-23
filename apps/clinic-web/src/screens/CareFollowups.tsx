import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const USER = 'demo-operator';

type OverdueFollowUp = { id: string; patientId: string; description: string; dueDate: string };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Overdue care follow-up work queue (EHR-006). A facility-wide worklist of care-plan
 * follow-ups that are still OPEN past their due date — the safety net that stops a
 * promised recall (a repeat test, a review, a titration) being lost between visits.
 * Not patient-scoped: it surfaces everyone's overdue follow-ups so nothing owed is
 * dropped. Reads GET /api/ehr/care-plan/overdue?asOf (matching paths on the edge and
 * the Worker; the read takes a plain date, no patient scope needed), and each item is
 * cleared by the confirmed-commit POST /api/ehr/care-plan/followup/complete (§9.2 —
 * the queue only clears the row once the hub durably accepts the completion).
 */
export function CareFollowups() {
  const [asOf, setAsOf] = useState(today());
  const [items, setItems] = useState<OverdueFollowUp[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (day: string) => {
    const r = await jsonFetch<{ overdue: OverdueFollowUp[] }>(`/api/ehr/care-plan/overdue?asOf=${encodeURIComponent(day)}`);
    setItems(r.overdue);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(asOf); setState('ready'); } catch { setState('error'); } })();
  }, [asOf, load]);

  const complete = async (item: OverdueFollowUp) => {
    setBusyId(item.id); setMsg(null);
    const res = await mutate<{ id: string }>('/api/ehr/care-plan/followup/complete', { id: item.id, user: USER }, { idempotencyKey: newIdempotencyKey() });
    setBusyId(null);
    if (res.ok) {
      setMsg({ tone: 'success', text: 'Follow-up completed and cleared from the queue.' });
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
      return;
    }
    setMsg({ tone: 'danger', text: res.errorCode === 'network'
      ? 'Could not reach the clinic hub — the follow-up is still open; retry when connected.'
      : `Could not complete (${res.errorCode ?? 'error'}). The follow-up is still open.` });
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading follow-up queue" />;
  if (state === 'error') return <StateBlock state="stale" title="Follow-up queue unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Overdue care follow-ups">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Overdue follow-ups (EHR-06)</h3>
          <StatusTag tone={items.length > 0 ? 'warning' : 'success'} icon={items.length > 0 ? 'alert' : 'check'}>
            {items.length > 0 ? `${items.length} overdue` : 'None overdue'}
          </StatusTag>
        </div>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="As of" type="date" hint="Follow-ups still open before this date" data-testid="cf-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      {items.length === 0
        ? <StateBlock state="empty" title="No overdue follow-ups">Every open care follow-up is on or ahead of its due date.</StateBlock>
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="cf-table">
              <caption className="sancta-visually-hidden">Care follow-ups still open past their due date, oldest first. Complete records the follow-up as done.</caption>
              <thead><tr><th scope="col">Patient</th><th scope="col">Follow-up</th><th scope="col">Due</th><th scope="col"></th></tr></thead>
              <tbody>
                {items.map((f) => (
                  <tr key={f.id}>
                    <td data-numeric>···{f.patientId.slice(-8)}</td>
                    <td>{f.description}</td>
                    <td data-numeric><StatusTag tone="warning">{f.dueDate}</StatusTag></td>
                    <td style={{ textAlign: 'right' }}>
                      <Button variant="primary" density="compact" data-testid="cf-complete" disabled={busyId === f.id} onClick={() => complete(f)}>Complete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
