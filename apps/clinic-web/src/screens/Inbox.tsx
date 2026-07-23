import { useEffect, useState } from 'react';
import { Banner, StatusTag, StateBlock } from '@sancta/ui';
import { api, type CriticalResult, type OpsTask } from '../api.ts';
import './screens.css';

/**
 * Clinical & operations inbox — unacknowledged critical results (ORD-07) and
 * overdue tasks (OPS-04). Safety-first: an unacknowledged CRITICAL result is the
 * most urgent thing in the clinic, so it leads with a danger banner and each item
 * names the responsible follow-up (§3.1). Read-only surface here; acknowledgement
 * happens in the result detail with its owner/action/escalation.
 */
export function Inbox() {
  const [critical, setCritical] = useState<CriticalResult[]>([]);
  const [tasks, setTasks] = useState<OpsTask[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setState('loading');
    void (async () => {
      try {
        const [c, t] = await Promise.all([api.criticalResults(), api.overdueTasks()]);
        setCritical(c.results); setTasks(t.tasks); setState('ready');
      } catch { setState('error'); }
    })();
  }, []);

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
                  <caption className="sancta-visually-hidden">Unacknowledged critical results, oldest first</caption>
                  <thead><tr><th scope="col">Result</th><th scope="col">Flag</th><th scope="col">Value</th><th scope="col">Released</th></tr></thead>
                  <tbody>
                    {critical.map((r) => (
                      <tr key={r.resultId}>
                        <td data-numeric>···{r.resultId.slice(-8)}</td>
                        <td><StatusTag tone="danger" icon="alert">{`Critical${r.abnormal && r.abnormal !== 'normal' ? ` · ${r.abnormal}` : ''}`}</StatusTag></td>
                        <td data-numeric>{r.value}</td>
                        <td data-numeric>{r.releasedAt.slice(0, 16).replace('T', ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
