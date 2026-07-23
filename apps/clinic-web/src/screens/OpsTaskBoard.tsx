import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type OpsTask = { taskId: string; subject: string; owner: string | null; priority: number; dueDate: string };

function isoToday(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Operational task board (OPS-003). The overdue queue is scoped by an as-of DATE
 * only (no uuid), so it is safe to read on mount and re-query. Creating a task and
 * completing one are confirmed-commit writes (§9.2): success only on res.ok, the
 * draft is preserved on failure, and the overdue list reloads after each success.
 */
export function OpsTaskBoard() {
  const [asOf, setAsOf] = useState(isoToday());
  const [tasks, setTasks] = useState<OpsTask[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Create-task draft.
  const [subject, setSubject] = useState('');
  const [owner, setOwner] = useState('');
  const [priority, setPriority] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [createIdem, setCreateIdem] = useState(newIdempotencyKey());
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Complete-task state.
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [completeMsg, setCompleteMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (d: string) => {
    setState('loading');
    try {
      const r = await jsonFetch<{ tasks: OpsTask[] }>(`/api/ops/tasks/overdue?asOf=${encodeURIComponent(d)}`);
      setTasks(r.tasks); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(asOf); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const createTask = async () => {
    if (subject.trim() === '') return;
    const p = priority.trim() === '' ? undefined : Number(priority);
    setCreating(true); setCreateMsg(null);
    const res = await mutate<{ taskId: string }>(
      '/api/ops/task',
      {
        subject: subject.trim(),
        ...(owner.trim() ? { owner: owner.trim() } : {}),
        ...(p !== undefined && Number.isFinite(p) ? { priority: p } : {}),
        ...(dueDate.trim() ? { dueDate } : {}),
      },
      { idempotencyKey: createIdem },
    );
    setCreating(false);
    if (res.ok && res.data?.taskId) {
      setCreateMsg({ tone: 'success', text: `Task created: ${subject.trim()}. Task id ···${res.data.taskId.slice(-8)}.` });
      setSubject(''); setOwner(''); setPriority(''); setDueDate(''); setCreateIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setCreateMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setCreateMsg({ tone: 'danger', text: `Could not create the task (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const completeTask = async (taskId: string, taskSubject: string) => {
    setCompletingId(taskId); setCompleteMsg(null);
    const res = await mutate<{ ok: boolean }>('/api/ops/task/complete', { taskId }, { idempotencyKey: newIdempotencyKey() });
    setCompletingId(null);
    if (res.ok) {
      setCompleteMsg({ tone: 'success', text: `Completed task: ${taskSubject} (···${taskId.slice(-8)}).` });
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setCompleteMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected.' });
    } else {
      setCompleteMsg({ tone: 'danger', text: `Could not complete the task (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}).` });
    }
  };

  return (
    <section className="scr" aria-label="Operational task board">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Overdue tasks (OPS-003)</h3>
            <Field label="As of" type="date" hint="Due before this date" data-testid="ops-tasks-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="ops-tasks-refresh" disabled={state === 'loading'} onClick={() => void load(asOf)}>Refresh</Button>
          </div>
          <StatusTag tone={tasks.length > 0 ? 'warning' : 'success'} icon={tasks.length > 0 ? 'alert' : 'check'}>
            {tasks.length > 0 ? `${tasks.length} overdue` : 'None overdue'}
          </StatusTag>
        </div>
        {completeMsg && <div style={{ marginTop: 'var(--sancta-space-2)' }}><Banner tone={completeMsg.tone} assertive={completeMsg.tone === 'danger'}>{completeMsg.text}</Banner></div>}
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading tasks" />}
        {state === 'error' && <StateBlock state="stale" title="Tasks unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          tasks.length === 0
            ? <StateBlock state="empty" title="Nothing overdue">No open tasks are past their due date on or before this date.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="ops-tasks-table">
                  <caption className="sancta-visually-hidden">Open operational tasks past their due date as of the selected date</caption>
                  <thead><tr><th scope="col">Priority</th><th scope="col">Subject</th><th scope="col">Owner</th><th scope="col">Due</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {tasks.map((t) => (
                      <tr key={t.taskId}>
                        <td data-numeric>{t.priority}</td>
                        <td>{t.subject}</td>
                        <td>{t.owner ?? '—'}</td>
                        <td data-numeric><StatusTag tone="danger" icon="alert">{`${t.dueDate} · overdue`}</StatusTag></td>
                        <td style={{ textAlign: 'right' }}>
                          <Button variant="subtle" density="compact" data-testid={`ops-task-complete-${t.taskId.slice(-8)}`} disabled={completingId === t.taskId}
                            onClick={() => void completeTask(t.taskId, t.subject)}>Complete</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="ops-task-create-form">
        <h3 className="scr__section-title">Create a task</h3>
        <p className="scr__kpi-meta">Add an operational task. A due date on or before the as-of date above will surface it in the overdue queue.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Subject" hint="What needs doing" data-testid="ops-task-subject" value={subject} onChange={(e) => setSubject(e.currentTarget.value)} />
          <Field label="Owner" optional hint="Who is responsible" data-testid="ops-task-owner" value={owner} onChange={(e) => setOwner(e.currentTarget.value)} />
          <Field label="Priority" optional numeric type="number" hint="Lower runs first (default 100)" data-testid="ops-task-priority" value={priority} onChange={(e) => setPriority(e.currentTarget.value)} />
          <Field label="Due date" optional type="date" hint="When it is due" data-testid="ops-task-due" value={dueDate} onChange={(e) => setDueDate(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="ops-task-submit" disabled={creating}
            {...(subject.trim() === '' ? { disabledReason: 'Enter the task subject' } : {})}
            onClick={createTask}>Create task</Button>
        </div>
        {createMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={createMsg.tone} assertive={createMsg.tone === 'danger'}>{createMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
