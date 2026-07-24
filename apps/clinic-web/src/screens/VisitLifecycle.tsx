import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';
type Durations = { visitId: string; waitMinutes: number | null; totalMinutes: number | null; events: Array<{ event: string; detail: string | null; at: string }> };
type Action = 'escalate' | 'hold' | 'resume' | 'outcome';

/**
 * Visit lifecycle (VIS-006). Inspect a visit's derived durations and event trail, and
 * apply an explicit, reason-carrying transition — escalate, hold, resume or end with an
 * outcome. Every transition is a confirmed-commit write (§9.2); the reason is mandatory
 * so the trail explains why a visit changed state.
 */
export function VisitLifecycle() {
  const [visitId, setVisitId] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [dur, setDur] = useState<Durations | null>(null);

  const [action, setAction] = useState<Action>('hold');
  const [reason, setReason] = useState('');
  const [priority, setPriority] = useState('');
  const [resumeTo, setResumeTo] = useState('');
  const [outcome, setOutcome] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = async () => {
    if (visitId.trim() === '') return;
    setState('loading'); setDur(null);
    try {
      const r = await jsonFetch<Durations>(`/api/visit-lifecycle/durations?visitId=${encodeURIComponent(visitId.trim())}`);
      setDur(r); setState('ready');
    } catch { setState('error'); }
  };

  const priOk = action !== 'escalate' || /^\d+$/.test(priority.trim());
  const extraOk = (action !== 'resume' || resumeTo.trim() !== '') && (action !== 'outcome' || outcome.trim() !== '');
  const ready = visitId.trim() !== '' && reason.trim() !== '' && priOk && extraOk;

  const apply = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    const vid = visitId.trim();
    const url = `/api/visit-lifecycle/${action}`;
    const body: Record<string, unknown> = { visitId: vid, reason: reason.trim(), by: BY };
    if (action === 'escalate') body['priority'] = Number(priority);
    if (action === 'resume') body['to'] = resumeTo.trim();
    if (action === 'outcome') body['outcome'] = outcome.trim();
    const res = await mutate<Record<string, unknown>>(url, body, { idempotencyKey: idem });
    setBusy(false);
    if (res.ok) {
      setIdem(newIdempotencyKey()); setReason(''); setPriority(''); setResumeTo(''); setOutcome('');
      setMsg({ tone: 'success', text: `Applied ${action} to visit ···${vid.slice(-8)}.` });
      try { await load(); } catch { /* covered */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not apply ${action} (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Visit lifecycle">
      <div className="scr__card" data-testid="visit-durations">
        <h3 className="scr__section-title">Visit durations</h3>
        <div className="scr__toolbar" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Visit id" hint="The visit to inspect" data-testid="visit-id" value={visitId} onChange={(e) => setVisitId(e.currentTarget.value)} />
          <Button variant="secondary" icon={<Icon name="sync" />} data-testid="visit-load" disabled={state === 'loading'}
            {...(visitId.trim() === '' ? { disabledReason: 'Enter a visit id' } : {})} onClick={load}>Load</Button>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading durations" />}
        {state === 'error' && <StateBlock state="stale" title="Visit not found">No visit with that id, or the hub is unreachable.</StateBlock>}
        {state === 'ready' && dur && (
          <>
            <div className="scr__row" style={{ marginTop: 'var(--sancta-space-2)' }}>
              <StatusTag tone="info">{`Wait ${dur.waitMinutes ?? '—'} min`}</StatusTag>
              <StatusTag tone="neutral">{`Total ${dur.totalMinutes ?? '—'} min`}</StatusTag>
            </div>
            <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-2)' }}>
              <table className="scr__table" data-testid="visit-events">
                <caption className="sancta-visually-hidden">The visit's recorded lifecycle events</caption>
                <thead><tr><th scope="col">Event</th><th scope="col">Detail</th><th scope="col">At</th></tr></thead>
                <tbody>
                  {dur.events.length === 0
                    ? <tr><td colSpan={3}>No events recorded.</td></tr>
                    : dur.events.map((ev, i) => (
                      <tr key={`${ev.event}-${i}`}><td>{ev.event}</td><td>{ev.detail ?? '—'}</td><td data-numeric>{new Date(ev.at).toLocaleString()}</td></tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="scr__card" data-testid="visit-transition">
        <h3 className="scr__section-title">Apply a transition</h3>
        <div className="scr__row" style={{ marginTop: 'var(--sancta-space-2)' }}>
          {(['escalate', 'hold', 'resume', 'outcome'] as const).map((a) => (
            <Button key={a} variant={action === a ? 'primary' : 'subtle'} density="compact" data-testid={`visit-action-${a}`} onClick={() => setAction(a)}>{a}</Button>
          ))}
        </div>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Reason" hint="Why the visit is changing state" data-testid="visit-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          {action === 'escalate' && <Field label="Priority" numeric hint="Higher is more urgent" data-testid="visit-priority" value={priority} onChange={(e) => setPriority(e.currentTarget.value)} />}
          {action === 'resume' && <Field label="Resume to" hint="State to resume into" data-testid="visit-resume-to" value={resumeTo} onChange={(e) => setResumeTo(e.currentTarget.value)} />}
          {action === 'outcome' && <Field label="Outcome" hint="Disposition of the visit" data-testid="visit-outcome" value={outcome} onChange={(e) => setOutcome(e.currentTarget.value)} />}
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone={action === 'outcome' ? 'danger' : 'action'} icon={<Icon name="check" />} data-testid="visit-apply" disabled={busy}
            {...(visitId.trim() === '' ? { disabledReason: 'Enter a visit id above' } : reason.trim() === '' ? { disabledReason: 'Enter a reason' } : !priOk ? { disabledReason: 'Enter a numeric priority' } : !extraOk ? { disabledReason: action === 'resume' ? 'Enter the state to resume to' : 'Enter the outcome' } : {})}
            onClick={apply}>{`Apply ${action}`}</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
