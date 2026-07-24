import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * Appointment reminders (APT-009). Preview the exact message text a patient would
 * receive (a sensitive appointment's reason is never placed in the message — enforced
 * server-side), then enqueue the reminder for an appointment. Enqueue is idempotent per
 * appointment+kind: re-enqueuing returns the existing one rather than a duplicate.
 */
export function ScheduleReminders() {
  const [when, setWhen] = useState('');
  const [time, setTime] = useState('');
  const [location, setLocation] = useState('');
  const [reason, setReason] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [appointmentId, setAppointmentId] = useState('');
  const [channel, setChannel] = useState('sms');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'info' | 'danger'; text: string } | null>(null);

  const doPreview = async () => {
    if (when.trim() === '') return;
    setPreviewing(true); setPreview(null);
    const res = await mutate<{ message: string }>(
      '/api/schedule/reminder',
      { when: when.trim(), ...(time.trim() ? { time: time.trim() } : {}), ...(location.trim() ? { location: location.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}), sensitive },
      { idempotencyKey: newIdempotencyKey() },
    );
    setPreviewing(false);
    if (res.ok && res.data) setPreview(res.data.message);
    else setPreview(null);
  };

  const enqueue = async () => {
    if (appointmentId.trim() === '' || when.trim() === '') return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string; enqueued: boolean }>(
      '/api/schedule/reminder-queue',
      {
        appointmentId: appointmentId.trim(),
        channel: channel.trim() || 'sms',
        info: { when: when.trim(), ...(time.trim() ? { time: time.trim() } : {}), ...(location.trim() ? { location: location.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}), sensitive },
      },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok && res.data) {
      setIdem(newIdempotencyKey());
      setMsg(res.data.enqueued
        ? { tone: 'success', text: `Reminder enqueued for appointment ···${appointmentId.trim().slice(-8)}.` }
        : { tone: 'info', text: 'A reminder of this kind was already queued for that appointment — nothing was duplicated.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not enqueue the reminder (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Appointment reminders">
      <div className="scr__card" data-testid="reminder-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Reminder details</h3>
          <StatusTag tone={sensitive ? 'warning' : 'neutral'} icon={sensitive ? 'alert' : null}>{sensitive ? 'Reason withheld' : 'Standard'}</StatusTag>
        </div>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="When" hint="Date of the appointment" data-testid="reminder-when" value={when} onChange={(e) => setWhen(e.currentTarget.value)} />
          <Field label="Time" optional hint="Time of the appointment" data-testid="reminder-time" value={time} onChange={(e) => setTime(e.currentTarget.value)} />
          <Field label="Location" optional hint="Where to attend" data-testid="reminder-location" value={location} onChange={(e) => setLocation(e.currentTarget.value)} />
          <Field label="Reason" optional hint="Omitted from the message if sensitive" data-testid="reminder-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant={sensitive ? 'primary' : 'secondary'} data-testid="reminder-sensitive" onClick={() => setSensitive((s) => !s)}>{sensitive ? 'Sensitive: on' : 'Sensitive: off'}</Button>
          <Button variant="secondary" icon={<Icon name="sync" />} data-testid="reminder-preview" disabled={previewing}
            {...(when.trim() === '' ? { disabledReason: 'Enter the appointment date' } : {})} onClick={doPreview}>Preview message</Button>
        </div>
        {preview !== null && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone="info">{`Message preview: ${preview}`}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="reminder-enqueue">
        <h3 className="scr__section-title">Enqueue for an appointment</h3>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Appointment id" hint="The appointment to remind about" data-testid="reminder-appt" value={appointmentId} onChange={(e) => setAppointmentId(e.currentTarget.value)} />
          <Field label="Channel" hint="sms, email or print" data-testid="reminder-channel" value={channel} onChange={(e) => setChannel(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="reminder-submit" disabled={busy}
            {...(appointmentId.trim() === '' ? { disabledReason: 'Enter the appointment id' } : when.trim() === '' ? { disabledReason: 'Enter the appointment date above' } : {})}
            onClick={enqueue}>Enqueue reminder</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
