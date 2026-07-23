import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Incident = { id: string; kind: string; severity: string; description: string; status: string };

const KINDS = ['incident', 'complaint', 'near_miss', 'failure'] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;
const STATUSES = ['open', 'investigating', 'closed'] as const;

function severityTone(s: string): 'danger' | 'warning' | 'neutral' {
  if (s === 'high') return 'danger';
  if (s === 'medium') return 'warning';
  return 'neutral';
}
function statusTone(s: string): 'success' | 'info' | 'warning' {
  if (s === 'closed') return 'success';
  if (s === 'investigating') return 'info';
  return 'warning';
}

/**
 * Facility incident register (OPS-005). Open incidents, complaints, near-misses and
 * failures, ordered by severity. Raise a new one, and update the status / corrective
 * action of an existing one. Closing an incident requires a corrective action — the
 * hub enforces this and rejects a bare close, which surfaces as a kept-draft failure.
 * Both writes are confirmed-commit; the list reloads after each.
 */
export function FacilityIncidents() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Raise draft.
  const [kind, setKind] = useState('');
  const [severity, setSeverity] = useState('');
  const [description, setDescription] = useState('');
  const [raiseIdem, setRaiseIdem] = useState(newIdempotencyKey());
  const [raising, setRaising] = useState(false);
  const [raiseMsg, setRaiseMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Update draft.
  const [incidentId, setIncidentId] = useState('');
  const [status, setStatus] = useState('');
  const [correctiveAction, setCorrectiveAction] = useState('');
  const [updateIdem, setUpdateIdem] = useState(newIdempotencyKey());
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const r = await jsonFetch<{ incidents: Incident[] }>(`/api/facility/incidents`);
      setIncidents(r.incidents); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const raise = async () => {
    if (kind.trim() === '' || description.trim() === '') return;
    setRaising(true); setRaiseMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/facility/incident',
      {
        kind: kind.trim(),
        description: description.trim(),
        ...(severity.trim() ? { severity: severity.trim() } : {}),
      },
      { idempotencyKey: raiseIdem },
    );
    setRaising(false);
    if (res.ok && res.data?.id) {
      setRaiseMsg({ tone: 'success', text: `Raised ${kind.trim()}${severity.trim() ? ` (${severity.trim()})` : ''}. Incident id ···${res.data.id.slice(-8)}.` });
      setDescription(''); setSeverity(''); setRaiseIdem(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setRaiseMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was raised — your entry is kept; retry when connected.' });
    } else {
      setRaiseMsg({ tone: 'danger', text: `Could not raise the incident (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const applyUpdate = async () => {
    if (incidentId.trim() === '' || (status.trim() === '' && correctiveAction.trim() === '')) return;
    setUpdating(true); setUpdateMsg(null);
    const res = await mutate<{ id: string; status: string }>(
      '/api/facility/incident/update',
      {
        id: incidentId.trim(),
        ...(status.trim() ? { status: status.trim() } : {}),
        ...(correctiveAction.trim() ? { correctiveAction: correctiveAction.trim() } : {}),
      },
      { idempotencyKey: updateIdem },
    );
    setUpdating(false);
    if (res.ok && res.data?.id) {
      setUpdateMsg({ tone: 'success', text: `Incident ···${incidentId.trim().slice(-8)} is now ${res.data.status}.` });
      setIncidentId(''); setStatus(''); setCorrectiveAction(''); setUpdateIdem(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setUpdateMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing changed — your entry is kept; retry when connected.' });
    } else {
      // e.g. "closing an incident requires a corrective action".
      setUpdateMsg({ tone: 'danger', text: `Could not update the incident (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const highCount = incidents.filter((i) => i.severity === 'high').length;

  return (
    <section className="scr" aria-label="Facility incident register" data-testid="facility-incidents">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Open incidents (OPS-005)</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="fac-inc-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          <StatusTag tone={highCount > 0 ? 'danger' : incidents.length > 0 ? 'warning' : 'success'} icon={incidents.length > 0 ? 'alert' : 'check'}>
            {highCount > 0 ? `${highCount} high · ${incidents.length} open` : incidents.length > 0 ? `${incidents.length} open` : 'None open'}
          </StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading incidents" />}
        {state === 'error' && <StateBlock state="stale" title="Incidents unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          incidents.length === 0
            ? <StateBlock state="empty" title="Nothing open">No incidents, complaints or near-misses are currently open.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="fac-inc-table">
                  <caption className="sancta-visually-hidden">Open facility incidents by severity with kind, description and status</caption>
                  <thead><tr><th scope="col">Kind</th><th scope="col">Severity</th><th scope="col">Description</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {incidents.map((inc, i) => (
                      <tr key={inc.id} data-selected={incidentId === inc.id || undefined}>
                        <td>{inc.kind}</td>
                        <td><StatusTag tone={severityTone(inc.severity)} icon={inc.severity === 'high' ? 'alert' : null}>{inc.severity}</StatusTag></td>
                        <td>{inc.description}</td>
                        <td><StatusTag tone={statusTone(inc.status)} icon={null}>{inc.status}</StatusTag></td>
                        <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`fac-inc-pick-${i}`} onClick={() => { setIncidentId(inc.id); setStatus(inc.status); setUpdateMsg(null); }}>Update</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="fac-inc-update-form">
        <h3 className="scr__section-title">Update an incident</h3>
        <p className="scr__kpi-meta">Pick an incident above or paste its id. Closing an incident requires a corrective action.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Incident id" hint="The incident to update" data-testid="fac-inc-update-id" value={incidentId} onChange={(e) => setIncidentId(e.currentTarget.value)} />
          <Field label="Status" optional hint={`One of: ${STATUSES.join(', ')}`} data-testid="fac-inc-update-status" value={status} onChange={(e) => setStatus(e.currentTarget.value)} />
          <Field label="Corrective action" optional hint="Required to close" data-testid="fac-inc-update-action" value={correctiveAction} onChange={(e) => setCorrectiveAction(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="fac-inc-update-submit" disabled={updating}
            {...(incidentId.trim() === '' ? { disabledReason: 'Choose or enter the incident id' } : status.trim() === '' && correctiveAction.trim() === '' ? { disabledReason: 'Set a status or a corrective action' } : {})}
            onClick={applyUpdate}>Apply update</Button>
        </div>
        {updateMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={updateMsg.tone} assertive={updateMsg.tone === 'danger'}>{updateMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="fac-inc-raise-form">
        <h3 className="scr__section-title">Raise an incident</h3>
        <p className="scr__kpi-meta">Capture an incident, complaint, near-miss or equipment failure. Severity defaults to low.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Kind" hint={`One of: ${KINDS.join(', ')}`} data-testid="fac-inc-raise-kind" value={kind} onChange={(e) => setKind(e.currentTarget.value)} />
          <Field label="Severity" optional hint={`One of: ${SEVERITIES.join(', ')}`} data-testid="fac-inc-raise-severity" value={severity} onChange={(e) => setSeverity(e.currentTarget.value)} />
          <Field label="Description" hint="What happened" data-testid="fac-inc-raise-description" value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="fac-inc-raise-submit" disabled={raising}
            {...(kind.trim() === '' ? { disabledReason: 'Enter the incident kind' } : description.trim() === '' ? { disabledReason: 'Enter a description' } : {})}
            onClick={raise}>Raise incident</Button>
        </div>
        {raiseMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={raiseMsg.tone} assertive={raiseMsg.tone === 'danger'}>{raiseMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
