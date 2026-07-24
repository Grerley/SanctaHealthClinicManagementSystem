import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const PURPOSES = ['clinical', 'billing', 'reminder', 'outreach'] as const;
const CHANNELS = ['sms', 'email', 'print'] as const;
const isPurpose = (v: string): boolean => (PURPOSES as readonly string[]).includes(v.trim());
const isChannel = (v: string): boolean => (CHANNELS as readonly string[]).includes(v.trim());

/**
 * Channel consent (COM-001). Records whether a patient permits messages of a given
 * purpose over a given channel. Consent is enforced upstream of the outbound queue,
 * so setting a preference here is what makes a later message send or be suppressed.
 * Confirmed-commit write (§9.2): the draft is preserved on failure.
 */
export function CommsConsent({ patient }: { patient: Patient | null }) {
  const [patientId, setPatientId] = useState(patient?.id ?? '');
  const [purpose, setPurpose] = useState('');
  const [channel, setChannel] = useState('');
  const [allowed, setAllowed] = useState(true);
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const ready = patientId.trim() !== '' && isPurpose(purpose) && isChannel(channel);

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    const pur = purpose.trim(); const chn = channel.trim();
    const res = await mutate<{ ok: true }>(
      '/api/comms/preference',
      { patientId: patientId.trim(), purpose: pur, channel: chn, allowed },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok) {
      setIdem(newIdempotencyKey());
      setMsg({ tone: 'success', text: `${allowed ? 'Allowed' : 'Blocked'} ${chn} for ${pur}.` });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not save the preference (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Channel consent">
      <div className="scr__card" data-testid="comms-consent-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Channel consent</h3>
          <StatusTag tone={allowed ? 'success' : 'warning'} icon={allowed ? 'check' : 'alert'}>{allowed ? 'Will allow' : 'Will block'}</StatusTag>
        </div>
        <p className="scr__kpi-meta">{patient ? `Setting consent for ${patient.given_name} ${patient.family_name}. ` : 'Enter the patient. '}Consent is applied before a message is queued — a blocked channel suppresses the message rather than sending it.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Patient id" hint="Who the preference is for" data-testid="comms-consent-patient" value={patientId} onChange={(e) => setPatientId(e.currentTarget.value)} />
          <Field label="Purpose" hint="One of: clinical, billing, reminder, outreach" data-testid="comms-consent-purpose" value={purpose} onChange={(e) => setPurpose(e.currentTarget.value)} />
          <Field label="Channel" hint="One of: sms, email, print" data-testid="comms-consent-channel" value={channel} onChange={(e) => setChannel(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant={allowed ? 'primary' : 'secondary'} data-testid="comms-consent-allow" onClick={() => setAllowed(true)}>Allow</Button>
          <Button variant={allowed ? 'secondary' : 'primary'} tone="danger" data-testid="comms-consent-block" onClick={() => setAllowed(false)}>Block</Button>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="comms-consent-submit" disabled={busy}
            {...(patientId.trim() === '' ? { disabledReason: 'Enter the patient id' } : !isPurpose(purpose) ? { disabledReason: 'Purpose must be clinical, billing, reminder or outreach' } : !isChannel(channel) ? { disabledReason: 'Channel must be sms, email or print' } : {})}
            onClick={submit}>Save preference</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
