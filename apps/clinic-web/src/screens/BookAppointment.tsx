import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, type CalendarEntry, type Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/** Appointment lifecycle a `booked` appointment can move to (domain §13.1). */
type ApptAction = { to: string; label: string; tone: 'neutral' | 'warning' | 'danger'; danger?: boolean };
const BOOKED_ACTIONS: ApptAction[] = [
  { to: 'confirmed', label: 'Confirm', tone: 'neutral' },
  { to: 'arrived', label: 'Mark arrived', tone: 'neutral' },
  { to: 'no_show', label: 'No-show', tone: 'danger', danger: true },
  { to: 'cancelled', label: 'Cancel', tone: 'warning', danger: true },
];

type SessionAppt = { appointmentId: string; slotId: string; label: string; status: string };

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
 * Book an appointment (APT-001) for the patient in context against an OPEN slot, and
 * run its lifecycle — confirm, arrival, no-show, cancel (APT-002/006). The open-slot
 * list is the calendar feed filtered to bookable windows; both reads work offline on
 * the LAN. Booking is a confirmed-commit write (§9.2): the backend takes a slot lock
 * and refuses a second booking, so a resource can never be double-booked. A 409
 * rejection ("slot no longer open") is surfaced clearly and the selection is KEPT so
 * nothing is lost — the list is then refreshed so the taken slot drops away. No-show
 * and cancellation release the slot back to open for the waiting list.
 */
export function BookAppointment({ patient }: { patient: Patient | null }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 13));
  const [slots, setSlots] = useState<CalendarEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selected, setSelected] = useState<CalendarEntry | null>(null);
  const [reason, setReason] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);
  const [session, setSession] = useState<SessionAppt[]>([]);

  const load = useCallback(async () => {
    const r = await calendar(from, to);
    setSlots(r.entries.filter((e) => e.status === 'open'));
  }, [from, to]);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const choose = (s: CalendarEntry) => { setSelected(s); setReason(''); setIdemKey(newIdempotencyKey()); setMsg(null); };

  const book = async () => {
    if (!selected || !patient) return;
    setBusy(true); setMsg(null);
    const slot = selected;
    const res = await mutate<{ ok: boolean; appointmentId?: string; reason?: string }>(
      '/api/schedule/book',
      { slotId: slot.slotId, patientId: patient.id, ...(slot.serviceCode ? { serviceCode: slot.serviceCode } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.appointmentId) {
      const label = `${slot.day} ${timeOf(slot.startsAt)} · ${slot.provider}${slot.room ? ' · ' + slot.room : ''}`;
      setSession((prev) => [{ appointmentId: res.data!.appointmentId!, slotId: slot.slotId, label, status: 'booked' }, ...prev]);
      setMsg({ tone: 'success', text: `Booked ${patient.family_name}, ${patient.given_name} into ${label}. Appointment ···${res.data.appointmentId.slice(-8)}.` });
      setSelected(null); setReason(''); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.data?.reason === 'slot_unavailable' || res.status === 409) {
      setMsg({ tone: 'danger', text: 'That slot is no longer open — it was taken while you were booking. Nothing was double-booked; your selection is kept. Pick another open slot below (the list has been refreshed).' });
      try { await load(); } catch { /* keep stale list */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was booked — your selection is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not book the slot (${res.errorCode ?? 'error'}). Your selection is kept.` });
    }
  };

  const changeStatus = async (appt: SessionAppt, action: ApptAction) => {
    setBusy(true); setMsg(null);
    const res = await mutate<{ status: string }>(
      '/api/schedule/status',
      { appointmentId: appt.appointmentId, to: action.to },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false);
    if (res.ok && res.data?.status) {
      setSession((prev) => prev.map((a) => (a.appointmentId === appt.appointmentId ? { ...a, status: res.data!.status } : a)));
      const released = action.to === 'no_show' || action.to === 'cancelled';
      setMsg({ tone: action.to === 'no_show' ? 'warning' : 'success',
        text: `Appointment ···${appt.appointmentId.slice(-8)} marked ${action.to.replace('_', ' ')}.${released ? ' The slot is released back to open for the waiting list.' : ''}` });
      if (released) { try { await load(); } catch { /* ignore */ } }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The appointment is unchanged; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not update the appointment (${res.errorCode ?? 'error'}).` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading open slots" />;
  if (state === 'error') return <StateBlock state="stale" title="Scheduling unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Book appointment">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Open slots (APT-001)</h3>
        <StatusTag tone={slots.length > 0 ? 'neutral' : 'success'} icon={slots.length > 0 ? null : 'check'}>
          {slots.length > 0 ? `${slots.length} open` : 'No open slots'}
        </StatusTag>
      </div>

      <div className="scr__row" style={{ alignItems: 'flex-end' }}>
        <label className="sancta-field" style={{ maxWidth: 180 }}>
          <span className="sancta-field__label">From</span>
          <input className="sancta-field-input" type="date" data-testid="book-from" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="sancta-field" style={{ maxWidth: 180 }}>
          <span className="sancta-field__label">To</span>
          <input className="sancta-field-input" type="date" data-testid="book-to" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {!patient && <Banner tone="info">Choose a patient from Patients to book them into a slot. The open-slot list is shown regardless.</Banner>}

      {slots.length === 0
        ? <StateBlock state="empty" title="No open slots in this window">Widen the date range or create slots in the Calendar.</StateBlock>
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="book-slots">
              <caption className="sancta-visually-hidden">Open appointment slots in the selected window. Select book to reserve one for the patient in context.</caption>
              <thead><tr><th scope="col">Day</th><th scope="col">Time</th><th scope="col">Provider</th><th scope="col">Room</th><th scope="col">Service</th><th scope="col"></th></tr></thead>
              <tbody>
                {slots.map((s) => (
                  <tr key={s.slotId} data-selected={selected?.slotId === s.slotId || undefined}>
                    <td>{s.day}</td>
                    <td data-numeric>{timeOf(s.startsAt)}–{timeOf(s.endsAt)}</td>
                    <td>{s.provider}</td>
                    <td>{s.room ?? '—'}</td>
                    <td>{s.serviceCode ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Button variant="primary" density="compact" data-testid="book-choose" onClick={() => choose(s)}>Book</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {selected && (
        <div className="scr__card" data-testid="book-panel">
          <h3 className="scr__section-title">Book — {selected.day} {timeOf(selected.startsAt)}–{timeOf(selected.endsAt)} · {selected.provider}</h3>
          <p className="scr__kpi-meta">
            {patient ? `Patient: ${patient.family_name}, ${patient.given_name} (${patient.mrn}).` : 'No patient in context — choose one from Patients to book.'}
          </p>
          <Field label="Reason" optional hint="Visible on the appointment; keep it non-sensitive" data-testid="book-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" data-testid="book-submit" disabled={busy}
              {...(!patient ? { disabledReason: 'Choose a patient in context first' } : {})}
              onClick={book}>Book appointment</Button>
            <Button variant="subtle" data-testid="book-cancel" disabled={busy} onClick={() => { setSelected(null); setMsg(null); }}>Cancel</Button>
          </div>
          {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone !== 'success'}>{msg.text}</Banner></div>}
        </div>
      )}
      {!selected && msg && <div data-testid="book-result"><Banner tone={msg.tone} assertive={msg.tone !== 'success'}>{msg.text}</Banner></div>}

      {session.length > 0 && (
        <div>
          <h3 className="scr__section-title">This session's appointments</h3>
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="book-lifecycle">
              <caption className="sancta-visually-hidden">Appointments booked this session, with lifecycle actions including no-show and cancel.</caption>
              <thead><tr><th scope="col">Appointment</th><th scope="col">Slot</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
              <tbody>
                {session.map((a) => {
                  const terminal = a.status !== 'booked';
                  return (
                    <tr key={a.appointmentId}>
                      <td data-numeric>···{a.appointmentId.slice(-8)}</td>
                      <td>{a.label}</td>
                      <td><StatusTag tone={a.status === 'no_show' ? 'danger' : a.status === 'cancelled' ? 'warning' : 'neutral'}>{a.status.replace('_', ' ')}</StatusTag></td>
                      <td>
                        <div className="scr__row">
                          {!terminal && BOOKED_ACTIONS.map((act) => (
                            <Button key={act.to} density="compact" variant={act.danger ? 'subtle' : 'secondary'} tone={act.danger ? 'danger' : 'action'}
                              disabled={busy} data-testid={`book-act-${act.to}`} onClick={() => changeStatus(a, act)}>{act.label}</Button>
                          ))}
                          {terminal && <span className="scr__kpi-meta">No further actions.</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
