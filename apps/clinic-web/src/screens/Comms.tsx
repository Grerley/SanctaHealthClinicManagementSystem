import { useCallback, useEffect, useState } from 'react';
import { Button, StatusTag, StateBlock, Banner } from '@sancta/ui';
import { api, type PendingMessage, type CommsTask } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';
const CHANNEL_TONE: Record<string, 'info' | 'neutral'> = { sms: 'info', email: 'info', print: 'neutral' };

/**
 * Communications desk (COMMS). Two work queues: outbound messages queued to a
 * patient's CONSENTED channel awaiting send (consent is enforced upstream — a
 * suppressed message never reaches this queue), and inbound replies turned into
 * tasks that stay open until a person actions them, so a patient reply is never
 * dropped. Marking sent and completing a task are confirmed-commit writes (§9.2).
 * Both reads are no-parameter, present on both the edge and the Worker.
 */
export function Comms() {
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [tasks, setTasks] = useState<CommsTask[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [p, t] = await Promise.all([api.commsPending(), api.commsTasks()]);
    setPending(p.pending); setTasks(t.tasks);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const act = async (key: string, url: string, body: unknown, okText: string) => {
    setBusy(key); setMsg(null);
    const res = await mutate<{ ok?: true; status?: string }>(url, body, { idempotencyKey: newIdempotencyKey() });
    setBusy(null);
    if (res.ok) { setMsg({ tone: 'success', text: okText }); try { await load(); } catch { /* covered */ } }
    else setMsg({ tone: 'danger', text: res.errorCode === 'network' ? 'Could not reach the clinic hub — nothing changed; retry when connected.' : `Action failed (${res.errorCode ?? 'error'}).` });
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading communications" />;
  if (state === 'error') return <StateBlock state="stale" title="Communications unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Communications desk">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Outbound queue</h3>
          <StatusTag tone={pending.length > 0 ? 'warning' : 'success'} icon={pending.length > 0 ? null : 'check'}>
            {pending.length > 0 ? `${pending.length} to send` : 'All sent'}
          </StatusTag>
        </div>
        {pending.length === 0
          ? <StateBlock state="empty" title="Nothing queued">No consented messages are waiting to be sent.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="comms-pending">
                <caption className="sancta-visually-hidden">Messages queued to a consented channel, awaiting send</caption>
                <thead><tr><th scope="col">Channel</th><th scope="col">Template</th><th scope="col">Patient</th><th scope="col"></th></tr></thead>
                <tbody>
                  {pending.map((m) => (
                    <tr key={m.messageId}>
                      <td><StatusTag tone={CHANNEL_TONE[m.channel] ?? 'neutral'}>{m.channel}</StatusTag></td>
                      <td>{m.template}</td>
                      <td data-numeric>···{m.patientId.slice(-8)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Button variant="secondary" density="compact" data-testid="comms-sent" disabled={busy === m.messageId}
                          onClick={() => act(m.messageId, '/api/comms/sent', { messageId: m.messageId }, 'Marked as sent.')}>Mark sent</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Inbound tasks</h3>
          <StatusTag tone={tasks.length > 0 ? 'warning' : 'success'} icon={tasks.length > 0 ? 'alert' : 'check'}>
            {tasks.length > 0 ? `${tasks.length} open` : 'All actioned'}
          </StatusTag>
        </div>
        {tasks.length === 0
          ? <StateBlock state="empty" title="No inbound tasks">Every patient reply has been actioned.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="comms-tasks">
                <caption className="sancta-visually-hidden">Inbound replies awaiting a person to action them</caption>
                <thead><tr><th scope="col">Summary</th><th scope="col">Patient</th><th scope="col"></th></tr></thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.taskId}>
                      <td>{t.summary}</td>
                      <td data-numeric>{t.patientId ? `···${t.patientId.slice(-8)}` : 'Unmatched'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Button variant="secondary" density="compact" data-testid="comms-complete" disabled={busy === t.taskId}
                          onClick={() => act(t.taskId, '/api/comms/tasks/complete', { taskId: t.taskId }, 'Task completed.')}>Complete</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
      {msg && <Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner>}
    </section>
  );
}
