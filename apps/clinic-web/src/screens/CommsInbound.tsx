import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type InboundResult = { taskId: string };

/**
 * Log an inbound patient reply (COM-005). An inbound message becomes an open task so a
 * person actions it — a patient reply is never dropped. The patient link and summary
 * are optional; the raw body is required. Confirmed-commit write (§9.2): the draft is
 * preserved on failure.
 */
export function CommsInbound({ patient }: { patient: Patient | null }) {
  const [patientId, setPatientId] = useState(patient?.id ?? '');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [assignedRole, setAssignedRole] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const submit = async () => {
    if (body.trim() === '') return;
    setBusy(true); setMsg(null);
    const res = await mutate<InboundResult>(
      '/api/comms/inbound',
      {
        body: body.trim(),
        ...(patientId.trim() ? { patientId: patientId.trim() } : {}),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        ...(assignedRole.trim() ? { assignedRole: assignedRole.trim() } : {}),
      },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok) {
      const ref = res.data?.taskId ? ` Task ···${res.data.taskId.slice(-8)}.` : '';
      setMsg({ tone: 'success', text: `Logged the inbound reply as an open task.${ref}` });
      setSummary(''); setBody(''); setAssignedRole(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not log the reply (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Log inbound reply">
      <div className="scr__card" data-testid="comms-inbound-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Log inbound reply</h3>
          <StatusTag tone="info" icon="info">Becomes an open task</StatusTag>
        </div>
        <p className="scr__kpi-meta">{patient ? `Linking to ${patient.given_name} ${patient.family_name}. ` : 'Link a patient if the reply can be matched, or leave blank to triage later. '}Every inbound reply is turned into a task so nothing is lost.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Patient id" optional hint="If the reply can be matched" data-testid="comms-inbound-patient" value={patientId} onChange={(e) => setPatientId(e.currentTarget.value)} />
          <Field label="Summary" optional hint="Short task title" data-testid="comms-inbound-summary" value={summary} onChange={(e) => setSummary(e.currentTarget.value)} />
          <Field label="Assign to role" optional hint="Which role should action it" data-testid="comms-inbound-role" value={assignedRole} onChange={(e) => setAssignedRole(e.currentTarget.value)} />
          <Field label="Message body" hint="What the patient said" data-testid="comms-inbound-body" value={body} onChange={(e) => setBody(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="comms-inbound-submit" disabled={busy}
            {...(body.trim() === '' ? { disabledReason: 'Enter the message body' } : {})}
            onClick={submit}>Log reply</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
