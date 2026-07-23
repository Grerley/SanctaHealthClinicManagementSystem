import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, type CalendarEntry, type Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function timeOf(iso: string): string { return iso.slice(11, 16); }

function calendar(from: string, to: string): Promise<{ entries: CalendarEntry[] }> {
  return jsonFetch<{ entries: CalendarEntry[] }>(`/api/schedule/calendar?from=${from}&to=${to}`);
}

/**
 * Waiting list (APT-004). Adds the patient in context to a provider's waiting list at
 * a priority, and fills a released (open) slot from that list: under a slot lock the
 * backend picks the highest-priority compatible waiting entry and books it — race-safe
 * and deterministic, never double-booked. Adding and filling are confirmed-commit
 * writes (§9.2); the draft is kept on any failure. The open-slot list is the calendar
 * feed filtered to bookable windows so a filled slot drops away after the write.
 */
export function Waitlist({ patient }: { patient: Patient | null }) {
  const today = new Date().toISOString().slice(0, 10);
  const [provider, setProvider] = useState('');
  const [serviceCode, setServiceCode] = useState('');
  const [priority, setPriority] = useState('0');
  const [reason, setReason] = useState('');
  const [addKey, setAddKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [from] = useState(today);
  const [to] = useState(addDays(today, 13));
  const [slots, setSlots] = useState<CalendarEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [fillMsg, setFillMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await calendar(from, to);
    setSlots(r.entries.filter((e) => e.status === 'open'));
  }, [from, to]);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const priorityNum = Number(priority);
  const canAdd = Boolean(patient) && provider.trim().length > 0 && Number.isFinite(priorityNum);

  const add = async () => {
    if (!patient || !canAdd) return;
    setBusy(true); setAddMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/schedule/waitlist',
      { patientId: patient.id, provider: provider.trim(), priority: priorityNum,
        ...(serviceCode.trim() ? { serviceCode: serviceCode.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) },
      { idempotencyKey: addKey },
    );
    setBusy(false);
    if (res.ok && res.data?.id) {
      setAddMsg({ tone: 'success', text: `${patient.family_name}, ${patient.given_name} added to ${provider.trim()}'s waiting list at priority ${priorityNum}. Entry ···${res.data.id.slice(-8)}.` });
      setReason(''); setAddKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setAddMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was added — your entry is kept; retry when connected.' });
    } else {
      setAddMsg({ tone: 'danger', text: `Could not add to the waiting list (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const fill = async (slot: CalendarEntry) => {
    setBusy(true); setFillMsg(null);
    const res = await mutate<{ filled: boolean; appointmentId?: string; waitlistId?: string; reason?: string }>(
      '/api/schedule/fill',
      { slotId: slot.slotId },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false);
    if (res.ok && res.data?.filled) {
      setFillMsg({ tone: 'success', text: `Slot ${slot.day} ${timeOf(slot.startsAt)} · ${slot.provider} filled from the waiting list. Appointment ···${(res.data.appointmentId ?? '').slice(-8)}.` });
      try { await load(); } catch { /* keep stale */ }
    } else if (res.ok && res.data && res.data.filled === false) {
      setFillMsg({ tone: 'warning', text: res.data.reason === 'no_candidate'
        ? `No compatible waiting entry for ${slot.provider} — the slot stays open.`
        : 'That slot is no longer open — nothing was changed.' });
      try { await load(); } catch { /* ignore */ }
    } else if (res.errorCode === 'network') {
      setFillMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The slot is unchanged; retry when connected.' });
    } else {
      setFillMsg({ tone: 'danger', text: `Could not fill the slot (${res.errorCode ?? 'error'}).` });
    }
  };

  return (
    <section className="scr" aria-label="Waiting list">
      <div>
        <h3 className="scr__section-title">Add to waiting list (APT-004)</h3>
        {!patient && <Banner tone="info">Choose a patient from Patients to add them to a provider's waiting list.</Banner>}
        <div className="scr__card" data-testid="wl-add-form">
          <p className="scr__kpi-meta">
            {patient ? `Patient: ${patient.family_name}, ${patient.given_name} (${patient.mrn}).` : 'No patient in context.'}
          </p>
          <div className="scr__form-grid">
            <Field label="Provider" hint="The provider to wait for" data-testid="wl-provider" value={provider} onChange={(e) => setProvider(e.currentTarget.value)} />
            <Field label="Service code" optional data-testid="wl-service" value={serviceCode} onChange={(e) => setServiceCode(e.currentTarget.value)} />
            <Field label="Priority" numeric hint="Higher is seen sooner" data-testid="wl-priority" value={priority} onChange={(e) => setPriority(e.currentTarget.value)} />
            <Field label="Reason" optional data-testid="wl-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          </div>
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" data-testid="wl-add" disabled={busy}
              {...(!canAdd ? { disabledReason: patient ? 'Enter a provider' : 'Choose a patient in context first' } : {})}
              onClick={add}>Add to waiting list</Button>
          </div>
          {addMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={addMsg.tone} assertive={addMsg.tone === 'danger'}>{addMsg.text}</Banner></div>}
        </div>
      </div>

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Fill an open slot from the list</h3>
          <StatusTag tone={slots.length > 0 ? 'neutral' : 'success'} icon={slots.length > 0 ? null : 'check'}>
            {slots.length > 0 ? `${slots.length} open` : 'No open slots'}
          </StatusTag>
        </div>
        {fillMsg && <div style={{ marginBottom: 'var(--sancta-space-3)' }}><Banner tone={fillMsg.tone} assertive={fillMsg.tone === 'danger'}>{fillMsg.text}</Banner></div>}
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading open slots" />}
        {state === 'error' && <StateBlock state="stale" title="Scheduling unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (slots.length === 0
          ? <StateBlock state="empty" title="No open slots">A released slot appears here for filling from the waiting list.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="wl-slots">
                <caption className="sancta-visually-hidden">Open slots. Fill takes the highest-priority compatible waiting entry for the slot's provider.</caption>
                <thead><tr><th scope="col">Day</th><th scope="col">Time</th><th scope="col">Provider</th><th scope="col">Service</th><th scope="col"></th></tr></thead>
                <tbody>
                  {slots.map((s) => (
                    <tr key={s.slotId}>
                      <td>{s.day}</td>
                      <td data-numeric>{timeOf(s.startsAt)}–{timeOf(s.endsAt)}</td>
                      <td>{s.provider}</td>
                      <td>{s.serviceCode ?? '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Button variant="primary" density="compact" data-testid="wl-fill" disabled={busy} onClick={() => fill(s)}>Fill from list</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>
    </section>
  );
}
