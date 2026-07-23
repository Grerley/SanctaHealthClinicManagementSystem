import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type DueItem = { id: string; assetTag: string; name: string; nextServiceDate: string };

function isoToday(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Equipment register + service/maintenance due (INV-010). The due list is scoped by
 * an as-of DATE only (no uuid), so it is safe to read on mount and re-query. Two
 * writes register new equipment into the asset register and record a service against
 * an existing asset — recording a service rolls its next-service date forward and
 * keeps an append-only service history. Both are confirmed-commit writes (§9.2) with
 * the draft preserved on failure; the due list reloads after each.
 */
export function Equipment() {
  const [asOf, setAsOf] = useState(isoToday());
  const [due, setDue] = useState<DueItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Register draft.
  const [assetTag, setAssetTag] = useState('');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [custodian, setCustodian] = useState('');
  const [regNextService, setRegNextService] = useState('');
  const [regIdem, setRegIdem] = useState(newIdempotencyKey());
  const [registering, setRegistering] = useState(false);
  const [regMsg, setRegMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Service draft.
  const [equipmentId, setEquipmentId] = useState('');
  const [servicedOn, setServicedOn] = useState(isoToday());
  const [serviceNote, setServiceNote] = useState('');
  const [nextService, setNextService] = useState('');
  const [svcIdem, setSvcIdem] = useState(newIdempotencyKey());
  const [servicing, setServicing] = useState(false);
  const [svcMsg, setSvcMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (d: string) => {
    setState('loading');
    try {
      const r = await jsonFetch<{ equipment: DueItem[] }>(`/api/equipment/due?asOf=${encodeURIComponent(d)}`);
      setDue(r.equipment); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(asOf); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const register = async () => {
    if (assetTag.trim() === '' || name.trim() === '') return;
    setRegistering(true); setRegMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/equipment',
      {
        assetTag: assetTag.trim(),
        name: name.trim(),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(custodian.trim() ? { custodian: custodian.trim() } : {}),
        ...(regNextService.trim() ? { nextServiceDate: regNextService } : {}),
      },
      { idempotencyKey: regIdem },
    );
    setRegistering(false);
    if (res.ok && res.data?.id) {
      setRegMsg({ tone: 'success', text: `Registered ${name.trim()} (${assetTag.trim()}). Asset id ···${res.data.id.slice(-8)}.` });
      setAssetTag(''); setName(''); setLocation(''); setCustodian(''); setRegNextService(''); setRegIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setRegMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was registered — your entry is kept; retry when connected.' });
    } else {
      setRegMsg({ tone: 'danger', text: `Could not register the equipment (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const recordService = async () => {
    if (equipmentId.trim() === '' || servicedOn.trim() === '') return;
    setServicing(true); setSvcMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/equipment/service',
      {
        equipmentId: equipmentId.trim(),
        servicedOn,
        ...(serviceNote.trim() ? { note: serviceNote.trim() } : {}),
        ...(nextService.trim() ? { nextServiceDate: nextService } : {}),
      },
      { idempotencyKey: svcIdem },
    );
    setServicing(false);
    if (res.ok && res.data?.id) {
      setSvcMsg({ tone: 'success', text: `Service recorded for ···${equipmentId.trim().slice(-8)} on ${servicedOn}${nextService ? `, next service ${nextService}` : ''}.` });
      setEquipmentId(''); setServiceNote(''); setNextService(''); setSvcIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setSvcMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was recorded — your entry is kept; retry when connected.' });
    } else {
      // e.g. "equipment not found".
      setSvcMsg({ tone: 'danger', text: `Could not record the service (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const overdue = (d: string) => d < asOf;

  return (
    <section className="scr" aria-label="Equipment register">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Service due (INV-010)</h3>
            <Field label="As of" type="date" hint="Due on or before" data-testid="eq-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="eq-refresh" disabled={state === 'loading'} onClick={() => void load(asOf)}>Refresh</Button>
          </div>
          <StatusTag tone={due.length > 0 ? 'warning' : 'success'} icon={due.length > 0 ? 'alert' : 'check'}>
            {due.length > 0 ? `${due.length} due` : 'All serviced'}
          </StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading equipment" />}
        {state === 'error' && <StateBlock state="stale" title="Equipment unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          due.length === 0
            ? <StateBlock state="empty" title="Nothing due">No equipment is due for service on or before this date.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="eq-due">
                  <caption className="sancta-visually-hidden">Equipment due or overdue for service as of the selected date</caption>
                  <thead><tr><th scope="col">Asset tag</th><th scope="col">Name</th><th scope="col">Next service</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {due.map((e) => (
                      <tr key={e.id} data-selected={equipmentId === e.id || undefined}>
                        <td data-numeric>{e.assetTag}</td>
                        <td>{e.name}</td>
                        <td data-numeric>
                          <StatusTag tone={overdue(e.nextServiceDate) ? 'danger' : 'warning'} icon="alert">{`${e.nextServiceDate}${overdue(e.nextServiceDate) ? ' · overdue' : ' · due'}`}</StatusTag>
                        </td>
                        <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`eq-service-${e.assetTag}`} onClick={() => { setEquipmentId(e.id); setSvcMsg(null); }}>Record service</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="eq-service-form">
        <h3 className="scr__section-title">Record a service</h3>
        <p className="scr__kpi-meta">Recording a service appends to the asset's service history and rolls its next-service date forward. Pick an asset from the due list above or paste its id.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Equipment id" hint="The asset being serviced" data-testid="eq-service-id" value={equipmentId} onChange={(e) => setEquipmentId(e.currentTarget.value)} />
          <Field label="Serviced on" type="date" hint="Date the service was performed" data-testid="eq-service-date" value={servicedOn} onChange={(e) => setServicedOn(e.currentTarget.value)} />
          <Field label="Next service date" optional type="date" hint="Rolls the schedule forward" data-testid="eq-service-next" value={nextService} onChange={(e) => setNextService(e.currentTarget.value)} />
          <Field label="Note" optional hint="What was done" data-testid="eq-service-note" value={serviceNote} onChange={(e) => setServiceNote(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="eq-service-submit" disabled={servicing}
            {...(equipmentId.trim() === '' ? { disabledReason: 'Choose or enter the equipment id' } : servicedOn.trim() === '' ? { disabledReason: 'Enter the service date' } : {})}
            onClick={recordService}>Record service</Button>
        </div>
        {svcMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={svcMsg.tone} assertive={svcMsg.tone === 'danger'}>{svcMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="eq-register-form">
        <h3 className="scr__section-title">Register equipment</h3>
        <p className="scr__kpi-meta">Add an asset to the register. A next-service date on or before the as-of date will surface it in the due list above.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Asset tag" hint="Unique asset identifier" data-testid="eq-reg-tag" value={assetTag} onChange={(e) => setAssetTag(e.currentTarget.value)} />
          <Field label="Name" hint="What the asset is" data-testid="eq-reg-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Field label="Location" optional hint="Where it lives" data-testid="eq-reg-location" value={location} onChange={(e) => setLocation(e.currentTarget.value)} />
          <Field label="Custodian" optional hint="Who is responsible" data-testid="eq-reg-custodian" value={custodian} onChange={(e) => setCustodian(e.currentTarget.value)} />
          <Field label="Next service date" optional type="date" hint="First scheduled service" data-testid="eq-reg-next" value={regNextService} onChange={(e) => setRegNextService(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="eq-reg-submit" disabled={registering}
            {...(assetTag.trim() === '' ? { disabledReason: 'Enter the asset tag' } : name.trim() === '' ? { disabledReason: 'Enter the asset name' } : {})}
            onClick={register}>Register asset</Button>
        </div>
        {regMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={regMsg.tone} assertive={regMsg.tone === 'danger'}>{regMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
