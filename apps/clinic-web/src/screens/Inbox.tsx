import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type CriticalResult, type OpsTask } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

// In production this is the authenticated clinician; the demo operator holds the
// clinical role. Acknowledgement records the responsible owner (§3.1).
const ACK_BY = 'demo-operator';

/**
 * Clinical & operations inbox — unacknowledged critical results (ORD-07) and
 * overdue tasks (OPS-04). Safety-first: an unacknowledged CRITICAL result is the
 * most urgent thing in the clinic, so it leads with a danger banner (§3.1).
 * Acknowledgement is a deliberate write (never optimistic): a responsible owner
 * and the action taken are required, and it commits before the item clears —
 * closing safety scenario #5.
 */
export function Inbox() {
  const [critical, setCritical] = useState<CriticalResult[]>([]);
  const [tasks, setTasks] = useState<OpsTask[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Acknowledge draft (§9.2 — the action text is preserved across a failed commit).
  const [ackTarget, setAckTarget] = useState<CriticalResult | null>(null);
  const [action, setAction] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [ackMsg, setAckMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [c, t] = await Promise.all([api.criticalResults(), api.overdueTasks()]);
    setCritical(c.results); setTasks(t.tasks);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => {
      try { await load(); setState('ready'); } catch { setState('error'); }
    })();
  }, [load]);

  const beginAck = (r: CriticalResult) => { setAckTarget(r); setAction(''); setIdemKey(newIdempotencyKey()); setAckMsg(null); };

  const acknowledge = async () => {
    if (!ackTarget || !action.trim()) return;
    setBusy(true); setAckMsg(null);
    const res = await mutate<{ ok: true }>(
      '/api/orders/critical/ack',
      { resultId: ackTarget.resultId, acknowledgedBy: ACK_BY, action: action.trim() },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok) {
      setAckMsg({ tone: 'success', text: 'Acknowledged and recorded with the action taken.' });
      setAckTarget(null); setAction('');
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setAckMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The acknowledgement was NOT recorded — your note is kept; retry when connected.' });
    } else {
      setAckMsg({ tone: 'danger', text: `Could not acknowledge (${res.errorCode ?? 'error'}). Your note is kept.` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading inbox" />;
  if (state === 'error') return <StateBlock state="stale" title="Inbox unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Clinical and operations inbox">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Unacknowledged critical results</h3>
          <StatusTag tone={critical.length > 0 ? 'danger' : 'success'} icon={critical.length > 0 ? 'alert' : 'check'}>
            {critical.length > 0 ? `${critical.length} needing action` : 'All acknowledged'}
          </StatusTag>
        </div>
        {critical.length === 0
          ? <StateBlock state="empty" title="No unacknowledged critical results">Every critical result has a recorded acknowledgement.</StateBlock>
          : (
            <>
              <Banner tone="danger" title="Critical results awaiting acknowledgement" assertive>
                These require a responsible clinician to acknowledge, act and escalate. Oldest first.
              </Banner>
              <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-2)' }}>
                <table className="scr__table" data-testid="inbox-critical">
                  <caption className="sancta-visually-hidden">Unacknowledged critical results, oldest first. Select acknowledge to record the owner and action.</caption>
                  <thead><tr><th scope="col">Result</th><th scope="col">Flag</th><th scope="col">Value</th><th scope="col">Released</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {critical.map((r) => (
                      <tr key={r.resultId} data-selected={ackTarget?.resultId === r.resultId || undefined}>
                        <td data-numeric>···{r.resultId.slice(-8)}</td>
                        <td><StatusTag tone="danger" icon="alert">{`Critical${r.abnormal && r.abnormal !== 'normal' ? ` · ${r.abnormal}` : ''}`}</StatusTag></td>
                        <td data-numeric>{r.value}</td>
                        <td data-numeric>{r.releasedAt.slice(0, 16).replace('T', ' ')}</td>
                        <td style={{ textAlign: 'right' }}><Button variant="primary" tone="danger" density="compact" data-testid="inbox-ack" onClick={() => beginAck(r)}>Acknowledge</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {ackTarget && (
                <div className="scr__card" data-testid="inbox-ack-panel" style={{ marginTop: 'var(--sancta-space-4)' }}>
                  <h3 className="scr__section-title">Acknowledge critical result ···{ackTarget.resultId.slice(-8)}</h3>
                  <p className="scr__kpi-meta">Recording your acknowledgement, the action taken and — where needed — escalation (§3.1).</p>
                  <div className="scr__row" style={{ alignItems: 'flex-end' }}>
                    <Field label="Action taken" hint="e.g. Called clinician; patient recalled; repeat ordered" data-testid="inbox-ack-action" value={action} onChange={(e) => setAction(e.currentTarget.value)} style={{ minWidth: 320 }} />
                    <Button variant="primary" tone="danger" data-testid="inbox-ack-submit" disabled={busy}
                      {...(!action.trim() ? { disabledReason: 'Describe the action taken before acknowledging' } : {})}
                      onClick={acknowledge}>Acknowledge & record</Button>
                    <Button variant="subtle" data-testid="inbox-ack-cancel" disabled={busy} onClick={() => { setAckTarget(null); setAckMsg(null); }}>Cancel</Button>
                  </div>
                  {ackMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={ackMsg.tone} assertive={ackMsg.tone === 'danger'}>{ackMsg.text}</Banner></div>}
                </div>
              )}
              {!ackTarget && ackMsg && <div data-testid="inbox-ack-result"><Banner tone={ackMsg.tone}>{ackMsg.text}</Banner></div>}
            </>
          )}
      </div>

      <div>
        <h3 className="scr__section-title">Overdue tasks</h3>
        {tasks.length === 0
          ? <StateBlock state="empty" title="No overdue tasks" />
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="inbox-tasks">
                <caption className="sancta-visually-hidden">Open tasks past their due date, highest priority first</caption>
                <thead><tr><th scope="col">Task</th><th scope="col">Owner</th><th scope="col">Priority</th><th scope="col">Due</th></tr></thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.taskId}>
                      <td>{t.subject}</td>
                      <td>{t.owner ?? 'Unassigned'}</td>
                      <td><StatusTag tone={t.priority <= 20 ? 'danger' : t.priority <= 50 ? 'warning' : 'neutral'}>{`P${t.priority}`}</StatusTag></td>
                      <td data-numeric>{t.dueDate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </section>
  );
}
