import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type BookingRequest = { id: string; patientId: string; provider: string | null; serviceCode: string | null; preferredDate: string | null };

const mask = (v: string): string => `···${v.slice(-8)}`;

/**
 * Staff confirmation of patient self-service booking requests (COM-006). A patient
 * can request a booking through the portal but never self-books: staff pick an open
 * slot and confirm, which books the appointment and marks the request confirmed.
 * The read is unscoped (pending queue) so it is safe on mount and re-query. Confirm
 * is a confirmed-commit write (§9.2) — the draft (slot id) is preserved on failure
 * and the queue reloads on success. Patient and request identifiers are never shown
 * in full — only a masked tail — and never placed in test ids or console output.
 */
export function SelfServiceBookingRequests() {
  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [requestId, setRequestId] = useState('');
  const [slotId, setSlotId] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const r = await jsonFetch<{ requests: BookingRequest[] }>('/api/selfservice/booking-requests');
      setRequests(r.requests); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const confirm = async () => {
    if (requestId.trim() === '' || slotId.trim() === '') return;
    setConfirming(true); setMsg(null);
    const res = await mutate<{ appointmentId: string }>(
      '/api/selfservice/confirm-booking',
      { requestId: requestId.trim(), slotId: slotId.trim() },
      { idempotencyKey: idem },
    );
    setConfirming(false);
    if (res.ok && res.data?.appointmentId) {
      setMsg({ tone: 'success', text: `Booking confirmed for request ${mask(requestId.trim())}. Appointment ${mask(res.data.appointmentId)}.` });
      setRequestId(''); setSlotId(''); setIdem(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not confirm the booking (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Self-service booking requests">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Pending online requests (COM-006)</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="ss-req-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          <StatusTag tone={requests.length > 0 ? 'warning' : 'success'} icon={requests.length > 0 ? 'alert' : 'check'}>
            {requests.length > 0 ? `${requests.length} pending` : 'None pending'}
          </StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading requests" />}
        {state === 'error' && <StateBlock state="stale" title="Requests unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          requests.length === 0
            ? <StateBlock state="empty" title="No pending requests">No patients are waiting for a booking to be confirmed.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="ss-req-table">
                  <caption className="sancta-visually-hidden">Pending self-service booking requests awaiting staff confirmation</caption>
                  <thead><tr><th scope="col">Request</th><th scope="col">Patient</th><th scope="col">Provider</th><th scope="col">Service</th><th scope="col">Preferred date</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id} data-selected={requestId === r.id || undefined}>
                        <td data-numeric>{mask(r.id)}</td>
                        <td data-numeric>{mask(r.patientId)}</td>
                        <td>{r.provider ?? '—'}</td>
                        <td>{r.serviceCode ?? '—'}</td>
                        <td data-numeric>{r.preferredDate ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`ss-req-pick-${r.id.slice(-8)}`} onClick={() => { setRequestId(r.id); setMsg(null); }}>Confirm</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="ss-confirm-form">
        <h3 className="scr__section-title">Confirm a request</h3>
        <p className="scr__kpi-meta">Choose a request above, then book it into an open slot. Confirming books the appointment and marks the request confirmed. Nothing is booked until the clinic hub commits.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Request id" hint="The self-service request being confirmed" data-testid="ss-confirm-request" value={requestId} onChange={(e) => setRequestId(e.currentTarget.value)} />
          <Field label="Slot id" hint="An open scheduling slot to book into" data-testid="ss-confirm-slot" value={slotId} onChange={(e) => setSlotId(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="ss-confirm-submit" disabled={confirming}
            {...(requestId.trim() === '' ? { disabledReason: 'Choose or enter the request id' } : slotId.trim() === '' ? { disabledReason: 'Enter the slot id to book into' } : {})}
            onClick={confirm}>Confirm booking</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
