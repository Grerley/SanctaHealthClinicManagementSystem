import { useState } from 'react';
import { Banner, Button, Field, Icon } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const mask = (v: string): string => `···${v.slice(-8)}`;

/**
 * Record a self-service booking request on a patient's behalf (COM-006). Authenticated
 * by the patient's portal access token — not staff RBAC — and only ever creates a
 * PENDING request; staff confirm it into an appointment on the Booking requests screen.
 * A confirmed-commit write (§9.2): the draft is preserved on failure so nothing typed
 * is lost. The access token is sensitive — never rendered in full, never logged, and
 * never placed in a test id.
 */
export function SelfServiceNewRequest() {
  const [token, setToken] = useState('');
  const [provider, setProvider] = useState('');
  const [serviceCode, setServiceCode] = useState('');
  const [preferredDate, setPreferredDate] = useState('');
  const [note, setNote] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const submit = async () => {
    if (token.trim() === '') return;
    setSaving(true); setMsg(null);
    const res = await mutate<{ id: string; status: string }>(
      '/api/selfservice/booking-request',
      {
        token: token.trim(),
        ...(provider.trim() ? { provider: provider.trim() } : {}),
        ...(serviceCode.trim() ? { serviceCode: serviceCode.trim() } : {}),
        ...(preferredDate.trim() ? { preferredDate } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      { idempotencyKey: idem },
    );
    setSaving(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `Request ${mask(res.data.id)} recorded as ${res.data.status ?? 'pending'}. Staff will confirm it into an appointment.` });
      setProvider(''); setServiceCode(''); setPreferredDate(''); setNote(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not record the request (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="New self-service booking request">
      <div className="scr__card" data-testid="ss-new-request-form">
        <h3 className="scr__section-title">Record a booking request (COM-006)</h3>
        <p className="scr__kpi-meta">Creates a pending online request authenticated by the patient's portal access token. It never books directly — staff confirm it into an appointment. The token is not stored on this screen or shown in full.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Access token" type="password" hint="The patient's portal access token" data-testid="ss-new-request-token" value={token} onChange={(e) => setToken(e.currentTarget.value)} />
          <Field label="Provider" optional hint="Preferred clinician" data-testid="ss-new-request-provider" value={provider} onChange={(e) => setProvider(e.currentTarget.value)} />
          <Field label="Service code" optional hint="Requested service" data-testid="ss-new-request-service" value={serviceCode} onChange={(e) => setServiceCode(e.currentTarget.value)} />
          <Field label="Preferred date" optional type="date" hint="When the patient would like to be seen" data-testid="ss-new-request-date" value={preferredDate} onChange={(e) => setPreferredDate(e.currentTarget.value)} />
          <Field label="Note" optional hint="Anything staff should know" data-testid="ss-new-request-note" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="ss-new-request-submit" disabled={saving}
            {...(token.trim() === '' ? { disabledReason: 'Enter the patient access token' } : {})}
            onClick={submit}>Record request</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
