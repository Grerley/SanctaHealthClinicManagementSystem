import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type DueItem = { id: string; resourceName: string; kind: string; dueDate: string };

const KINDS = ['maintenance', 'calibration', 'downtime'] as const;

function isoToday(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Facility maintenance schedule (OPS-006). Maintenance, calibration and downtime due
 * on or before an as-of date and not yet performed. Two confirmed-commit writes:
 * schedule new work against a resource, and mark a due record complete. The due list
 * reloads after each write; the draft is kept on failure.
 */
export function FacilityMaintenance() {
  const [asOf, setAsOf] = useState(isoToday());
  const [due, setDue] = useState<DueItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Schedule draft.
  const [resourceId, setResourceId] = useState('');
  const [kind, setKind] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [scheduleNotes, setScheduleNotes] = useState('');
  const [schedIdem, setSchedIdem] = useState(newIdempotencyKey());
  const [scheduling, setScheduling] = useState(false);
  const [schedMsg, setSchedMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Complete draft.
  const [completeId, setCompleteId] = useState('');
  const [completeNotes, setCompleteNotes] = useState('');
  const [completeIdem, setCompleteIdem] = useState(newIdempotencyKey());
  const [completing, setCompleting] = useState(false);
  const [completeMsg, setCompleteMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (d: string) => {
    setState('loading');
    try {
      const r = await jsonFetch<{ due: DueItem[] }>(`/api/facility/maintenance/due?asOf=${encodeURIComponent(d)}`);
      setDue(r.due); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(asOf); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const schedule = async () => {
    if (resourceId.trim() === '' || kind.trim() === '' || dueDate.trim() === '') return;
    setScheduling(true); setSchedMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/facility/maintenance',
      {
        resourceId: resourceId.trim(),
        kind: kind.trim(),
        dueDate,
        ...(scheduleNotes.trim() ? { notes: scheduleNotes.trim() } : {}),
      },
      { idempotencyKey: schedIdem },
    );
    setScheduling(false);
    if (res.ok && res.data?.id) {
      setSchedMsg({ tone: 'success', text: `Scheduled ${kind.trim()} for ···${resourceId.trim().slice(-8)}, due ${dueDate}. Record id ···${res.data.id.slice(-8)}.` });
      setResourceId(''); setDueDate(''); setScheduleNotes(''); setSchedIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setSchedMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was scheduled — your entry is kept; retry when connected.' });
    } else {
      setSchedMsg({ tone: 'danger', text: `Could not schedule the work (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const complete = async () => {
    if (completeId.trim() === '') return;
    setCompleting(true); setCompleteMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/facility/maintenance/complete',
      {
        id: completeId.trim(),
        ...(completeNotes.trim() ? { notes: completeNotes.trim() } : {}),
      },
      { idempotencyKey: completeIdem },
    );
    setCompleting(false);
    if (res.ok && res.data?.id) {
      setCompleteMsg({ tone: 'success', text: `Marked ···${completeId.trim().slice(-8)} complete.` });
      setCompleteId(''); setCompleteNotes(''); setCompleteIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setCompleteMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing changed — your entry is kept; retry when connected.' });
    } else {
      // e.g. "maintenance record not found or already completed".
      setCompleteMsg({ tone: 'danger', text: `Could not complete the record (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const overdue = (d: string) => d < asOf;

  return (
    <section className="scr" aria-label="Facility maintenance schedule" data-testid="facility-maintenance">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Maintenance due (OPS-006)</h3>
            <Field label="As of" type="date" hint="Due on or before" data-testid="fac-mnt-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="fac-mnt-refresh" disabled={state === 'loading'} onClick={() => void load(asOf)}>Refresh</Button>
          </div>
          <StatusTag tone={due.length > 0 ? 'warning' : 'success'} icon={due.length > 0 ? 'alert' : 'check'}>
            {due.length > 0 ? `${due.length} due` : 'None due'}
          </StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading maintenance" />}
        {state === 'error' && <StateBlock state="stale" title="Maintenance unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          due.length === 0
            ? <StateBlock state="empty" title="Nothing due">No maintenance is due on or before this date.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="fac-mnt-table">
                  <caption className="sancta-visually-hidden">Facility maintenance due or overdue on or before the selected date</caption>
                  <thead><tr><th scope="col">Resource</th><th scope="col">Kind</th><th scope="col">Due</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {due.map((m, i) => (
                      <tr key={m.id} data-selected={completeId === m.id || undefined}>
                        <td>{m.resourceName}</td>
                        <td>{m.kind}</td>
                        <td data-numeric>
                          <StatusTag tone={overdue(m.dueDate) ? 'danger' : 'warning'} icon="alert">{`${m.dueDate}${overdue(m.dueDate) ? ' · overdue' : ' · due'}`}</StatusTag>
                        </td>
                        <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`fac-mnt-pick-${i}`} onClick={() => { setCompleteId(m.id); setCompleteMsg(null); }}>Mark complete</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="fac-mnt-complete-form">
        <h3 className="scr__section-title">Mark maintenance complete</h3>
        <p className="scr__kpi-meta">Pick a due record above or paste its id. Completing a record stamps who performed it and when.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Record id" hint="The maintenance record" data-testid="fac-mnt-complete-id" value={completeId} onChange={(e) => setCompleteId(e.currentTarget.value)} />
          <Field label="Notes" optional hint="What was done" data-testid="fac-mnt-complete-notes" value={completeNotes} onChange={(e) => setCompleteNotes(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="fac-mnt-complete-submit" disabled={completing}
            {...(completeId.trim() === '' ? { disabledReason: 'Choose or enter the record id' } : {})}
            onClick={complete}>Mark complete</Button>
        </div>
        {completeMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={completeMsg.tone} assertive={completeMsg.tone === 'danger'}>{completeMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="fac-mnt-schedule-form">
        <h3 className="scr__section-title">Schedule maintenance</h3>
        <p className="scr__kpi-meta">Book maintenance, calibration or downtime against a resource. A due date on or before the as-of date surfaces it above.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Resource id" hint="The resource to service" data-testid="fac-mnt-sched-resource" value={resourceId} onChange={(e) => setResourceId(e.currentTarget.value)} />
          <Field label="Kind" hint={`One of: ${KINDS.join(', ')}`} data-testid="fac-mnt-sched-kind" value={kind} onChange={(e) => setKind(e.currentTarget.value)} />
          <Field label="Due date" type="date" hint="When it is due" data-testid="fac-mnt-sched-due" value={dueDate} onChange={(e) => setDueDate(e.currentTarget.value)} />
          <Field label="Notes" optional hint="Any detail" data-testid="fac-mnt-sched-notes" value={scheduleNotes} onChange={(e) => setScheduleNotes(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="fac-mnt-sched-submit" disabled={scheduling}
            {...(resourceId.trim() === '' ? { disabledReason: 'Enter the resource id' } : kind.trim() === '' ? { disabledReason: 'Enter the maintenance kind' } : dueDate.trim() === '' ? { disabledReason: 'Enter the due date' } : {})}
            onClick={schedule}>Schedule</Button>
        </div>
        {schedMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={schedMsg.tone} assertive={schedMsg.tone === 'danger'}>{schedMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
