import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const PURPOSES = ['clinical', 'billing', 'reminder', 'outreach'] as const;
const CHANNELS = ['sms', 'email', 'print'] as const;
const PURPOSE_HINT = 'One of: clinical, billing, reminder, outreach';
const CHANNEL_HINT = 'One of: sms, email, print';

type QueueResult = { messageId: string; status: 'queued' | 'suppressed' | 'duplicate' };

function isPurpose(v: string): boolean { return (PURPOSES as readonly string[]).includes(v.trim()); }
function isChannel(v: string): boolean { return (CHANNELS as readonly string[]).includes(v.trim()); }

/**
 * Compose an outbound message (COM-001/002). Consent is enforced server-side: a
 * message to a non-consented channel comes back `suppressed` — an expected outcome
 * surfaced plainly, never as an error. A composed dedup key means resubmitting the
 * same message to the same patient/purpose/channel returns `duplicate` rather than
 * queuing a second copy (send-once, COM-002). Confirmed-commit write (§9.2): the
 * draft is preserved on failure and a fresh idempotency key is minted per submit.
 */
export function CommsCompose({ patient }: { patient: Patient | null }) {
  const [patientId, setPatientId] = useState(patient?.id ?? '');
  const [purpose, setPurpose] = useState('');
  const [channel, setChannel] = useState('');
  const [template, setTemplate] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'info' | 'warning' | 'danger'; text: string } | null>(null);

  const ready = patientId.trim() !== '' && isPurpose(purpose) && isChannel(channel) && template.trim() !== '';

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    const pid = patientId.trim();
    const pur = purpose.trim();
    const chn = channel.trim();
    const tpl = template.trim();
    const dedupKey = `${pid}:${pur}:${chn}:${tpl}`;
    const res = await mutate<QueueResult>(
      '/api/comms/message',
      { patientId: pid, purpose: pur, channel: chn, template: tpl, dedupKey },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok) {
      const status = res.data?.status ?? 'queued';
      setIdem(newIdempotencyKey());
      if (status === 'suppressed') {
        setMsg({ tone: 'warning', text: `${chn} not consented for ${pur} — nothing sent. Record consent on the Channel consent screen first.` });
      } else if (status === 'duplicate') {
        setMsg({ tone: 'info', text: 'Already queued — this exact message was queued before; nothing was duplicated.' });
      } else {
        const ref = res.data?.messageId ? ` Message ···${res.data.messageId.slice(-8)}.` : '';
        setMsg({ tone: 'success', text: `Queued the ${tpl} ${chn} message.${ref}` });
        setTemplate('');
      }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not queue the message (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Compose message">
      <div className="scr__card" data-testid="comms-compose-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Compose message</h3>
          <StatusTag tone="info" icon="info">Consent enforced upstream</StatusTag>
        </div>
        <p className="scr__kpi-meta">
          {patient ? `Composing for ${patient.given_name} ${patient.family_name}. ` : 'Enter the patient the message is for. '}
          Only approved templates are accepted here — no free-text clinical content (COM-003). A non-consented channel is suppressed, not sent.
        </p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Patient id" hint="Who the message is for" data-testid="comms-compose-patient" value={patientId} onChange={(e) => setPatientId(e.currentTarget.value)} />
          <Field label="Purpose" hint={PURPOSE_HINT} data-testid="comms-compose-purpose" value={purpose} onChange={(e) => setPurpose(e.currentTarget.value)} />
          <Field label="Channel" hint={CHANNEL_HINT} data-testid="comms-compose-channel" value={channel} onChange={(e) => setChannel(e.currentTarget.value)} />
          <Field label="Template" hint="Approved template name" data-testid="comms-compose-template" value={template} onChange={(e) => setTemplate(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="comms-compose-submit" disabled={busy}
            {...(patientId.trim() === '' ? { disabledReason: 'Enter the patient id' } : !isPurpose(purpose) ? { disabledReason: 'Purpose must be one of clinical, billing, reminder, outreach' } : !isChannel(channel) ? { disabledReason: 'Channel must be one of sms, email, print' } : template.trim() === '' ? { disabledReason: 'Enter the template' } : {})}
            onClick={submit}>Queue message</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
