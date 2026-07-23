import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Resource = { id: string; kind: string; name: string; capacity: number | null; status: string };

const KINDS = ['room', 'service_point', 'equipment'] as const;
const STATUSES = ['available', 'in_use', 'maintenance', 'retired'] as const;

function statusTone(s: string): 'success' | 'info' | 'warning' | 'neutral' {
  if (s === 'available') return 'success';
  if (s === 'in_use') return 'info';
  if (s === 'maintenance') return 'warning';
  return 'neutral';
}

/**
 * Facility resource board (OPS-002). Rooms, service points and equipment with their
 * live status. Two confirmed-commit writes: add a resource to the register, and set
 * an existing resource's status. The list reloads after each write; the draft is kept
 * on failure.
 */
export function FacilityResources() {
  const [kindFilter, setKindFilter] = useState('');
  const [resources, setResources] = useState<Resource[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Add draft.
  const [kind, setKind] = useState('');
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [site, setSite] = useState('');
  const [addIdem, setAddIdem] = useState(newIdempotencyKey());
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Status draft.
  const [statusId, setStatusId] = useState('');
  const [status, setStatus] = useState('');
  const [statusIdem, setStatusIdem] = useState(newIdempotencyKey());
  const [savingStatus, setSavingStatus] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (k: string) => {
    setState('loading');
    try {
      const q = k.trim() ? `?kind=${encodeURIComponent(k.trim())}` : '';
      const r = await jsonFetch<{ resources: Resource[] }>(`/api/facility/resources${q}`);
      setResources(r.resources); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(kindFilter); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const capNum = Number(capacity);
  const capValid = capacity.trim() === '' || Number.isFinite(capNum);

  const addResource = async () => {
    if (kind.trim() === '' || name.trim() === '') return;
    setAdding(true); setAddMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/facility/resource',
      {
        kind: kind.trim(),
        name: name.trim(),
        ...(capacity.trim() && Number.isFinite(capNum) ? { capacity: capNum } : {}),
        ...(site.trim() ? { site: site.trim() } : {}),
      },
      { idempotencyKey: addIdem },
    );
    setAdding(false);
    if (res.ok && res.data?.id) {
      setAddMsg({ tone: 'success', text: `Added ${name.trim()} (${kind.trim()}). Resource id ···${res.data.id.slice(-8)}.` });
      setName(''); setCapacity(''); setSite(''); setAddIdem(newIdempotencyKey());
      try { await load(kindFilter); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setAddMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was added — your entry is kept; retry when connected.' });
    } else {
      setAddMsg({ tone: 'danger', text: `Could not add the resource (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const saveStatus = async () => {
    if (statusId.trim() === '' || status.trim() === '') return;
    setSavingStatus(true); setStatusMsg(null);
    const res = await mutate<{ id: string; status: string }>(
      '/api/facility/resource/status',
      { id: statusId.trim(), status: status.trim() },
      { idempotencyKey: statusIdem },
    );
    setSavingStatus(false);
    if (res.ok && res.data?.id) {
      setStatusMsg({ tone: 'success', text: `Status of ···${statusId.trim().slice(-8)} set to ${status.trim()}.` });
      setStatusId(''); setStatus(''); setStatusIdem(newIdempotencyKey());
      try { await load(kindFilter); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setStatusMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing changed — your entry is kept; retry when connected.' });
    } else {
      setStatusMsg({ tone: 'danger', text: `Could not change the status (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const unavailable = resources.filter((r) => r.status !== 'available').length;

  return (
    <section className="scr" aria-label="Facility resource board" data-testid="facility-resources">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Resources (OPS-002)</h3>
            <Field label="Kind filter" optional hint="room, service_point or equipment; blank for all" data-testid="fac-res-filter" value={kindFilter} onChange={(e) => setKindFilter(e.currentTarget.value)} />
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="fac-res-refresh" disabled={state === 'loading'} onClick={() => void load(kindFilter)}>Refresh</Button>
          </div>
          <StatusTag tone={unavailable > 0 ? 'warning' : 'success'} icon={unavailable > 0 ? 'alert' : 'check'}>
            {unavailable > 0 ? `${unavailable} not available` : 'All available'}
          </StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading resources" />}
        {state === 'error' && <StateBlock state="stale" title="Resources unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          resources.length === 0
            ? <StateBlock state="empty" title="No resources">No facility resources match this filter.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="fac-res-table">
                  <caption className="sancta-visually-hidden">Facility resources with kind, capacity and current status</caption>
                  <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Capacity</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {resources.map((r, i) => (
                      <tr key={r.id} data-selected={statusId === r.id || undefined}>
                        <td>{r.name}</td>
                        <td>{r.kind}</td>
                        <td data-numeric>{r.capacity ?? '—'}</td>
                        <td><StatusTag tone={statusTone(r.status)} icon={null}>{r.status}</StatusTag></td>
                        <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`fac-res-pick-${i}`} onClick={() => { setStatusId(r.id); setStatus(r.status); setStatusMsg(null); }}>Change status</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="fac-res-status-form">
        <h3 className="scr__section-title">Change resource status</h3>
        <p className="scr__kpi-meta">Pick a resource from the board above or paste its id, then set its status.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Resource id" hint="The resource to update" data-testid="fac-res-status-id" value={statusId} onChange={(e) => setStatusId(e.currentTarget.value)} />
          <Field label="Status" hint={`One of: ${STATUSES.join(', ')}`} data-testid="fac-res-status-value" value={status} onChange={(e) => setStatus(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="fac-res-status-submit" disabled={savingStatus}
            {...(statusId.trim() === '' ? { disabledReason: 'Choose or enter the resource id' } : status.trim() === '' ? { disabledReason: 'Enter the new status' } : {})}
            onClick={saveStatus}>Save status</Button>
        </div>
        {statusMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={statusMsg.tone} assertive={statusMsg.tone === 'danger'}>{statusMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="fac-res-add-form">
        <h3 className="scr__section-title">Add a resource</h3>
        <p className="scr__kpi-meta">Register a room, service point or equipment into the facility board.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Kind" hint={`One of: ${KINDS.join(', ')}`} data-testid="fac-res-add-kind" value={kind} onChange={(e) => setKind(e.currentTarget.value)} />
          <Field label="Name" hint="What the resource is called" data-testid="fac-res-add-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Field label="Capacity" optional numeric hint="People or units it holds" data-testid="fac-res-add-capacity" value={capacity} {...(capValid ? {} : { error: 'Enter a number' })} onChange={(e) => setCapacity(e.currentTarget.value)} />
          <Field label="Site" optional hint="Where it lives" data-testid="fac-res-add-site" value={site} onChange={(e) => setSite(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="fac-res-add-submit" disabled={adding}
            {...(kind.trim() === '' ? { disabledReason: 'Enter the resource kind' } : name.trim() === '' ? { disabledReason: 'Enter the resource name' } : !capValid ? { disabledReason: 'Capacity must be a number' } : {})}
            onClick={addResource}>Add resource</Button>
        </div>
        {addMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={addMsg.tone} assertive={addMsg.tone === 'danger'}>{addMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
