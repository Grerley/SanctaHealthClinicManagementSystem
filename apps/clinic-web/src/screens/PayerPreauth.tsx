import { useState } from 'react';
import { Banner, Button, Field, Icon } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * Pre-authorisation (BIL-011). Requesting a pre-auth records that approval is being
 * sought from a payer for a service; deciding approves (with an authorisation code)
 * or declines a requested pre-auth. Both are confirmed-commit writes (§9.2): the
 * draft is preserved on failure and a fresh idempotency key is minted only after a
 * durable commit.
 */
export function PayerPreauth({ patient }: { patient: Patient | null }) {
  const prefill = patient?.id ?? '';

  // Request draft.
  const [reference, setReference] = useState('');
  const [patientId, setPatientId] = useState(prefill);
  const [payerId, setPayerId] = useState('');
  const [serviceCode, setServiceCode] = useState('');
  const [note, setNote] = useState('');
  const [reqIdem, setReqIdem] = useState(newIdempotencyKey());
  const [requesting, setRequesting] = useState(false);
  const [reqMsg, setReqMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Decide draft.
  const [preauthId, setPreauthId] = useState('');
  const [authorisation, setAuthorisation] = useState('');
  const [decIdem, setDecIdem] = useState(newIdempotencyKey());
  const [deciding, setDeciding] = useState(false);
  const [decMsg, setDecMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const request = async () => {
    if (reference.trim() === '' || patientId.trim() === '' || payerId.trim() === '' || serviceCode.trim() === '') return;
    setRequesting(true); setReqMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/payer/preauth',
      {
        reference: reference.trim(),
        patientId: patientId.trim(),
        payerId: payerId.trim(),
        serviceCode: serviceCode.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      { idempotencyKey: reqIdem },
    );
    setRequesting(false);
    if (res.ok && res.data?.id) {
      setReqMsg({ tone: 'success', text: `Pre-authorisation ${reference.trim()} requested. Pre-auth id ···${res.data.id.slice(-8)}.` });
      setReference(''); setPayerId(''); setServiceCode(''); setNote(''); setReqIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setReqMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setReqMsg({ tone: 'danger', text: `Could not request the pre-authorisation (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const decide = async (approve: boolean) => {
    if (preauthId.trim() === '') return;
    setDeciding(true); setDecMsg(null);
    const res = await mutate<{ status: 'approved' | 'declined' }>(
      '/api/payer/preauth/decide',
      {
        preauthId: preauthId.trim(),
        approve,
        ...(approve && authorisation.trim() ? { authorisation: authorisation.trim() } : {}),
      },
      { idempotencyKey: decIdem },
    );
    setDeciding(false);
    if (res.ok && res.data?.status) {
      setDecMsg({ tone: 'success', text: `Pre-authorisation ···${preauthId.trim().slice(-8)} ${res.data.status}.` });
      setPreauthId(''); setAuthorisation(''); setDecIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setDecMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setDecMsg({ tone: 'danger', text: `Could not record the decision (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Pre-authorisation">
      <div className="scr__card" data-testid="payer-preauth-form">
        <h3 className="scr__section-title">Request a pre-authorisation</h3>
        <p className="scr__kpi-meta">Seek payer approval for a service before it is delivered. The reference is your tracking id; the service code identifies what is being authorised.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Reference" hint="Your pre-auth reference" data-testid="payer-preauth-ref" value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
          <Field label="Patient id" hint="Who the service is for" data-testid="payer-preauth-patient" value={patientId} onChange={(e) => setPatientId(e.currentTarget.value)} />
          <Field label="Payer id" hint="The payer being asked" data-testid="payer-preauth-payer" value={payerId} onChange={(e) => setPayerId(e.currentTarget.value)} />
          <Field label="Service code" hint="What is being authorised" data-testid="payer-preauth-service" value={serviceCode} onChange={(e) => setServiceCode(e.currentTarget.value)} />
          <Field label="Note" optional hint="Clinical justification" data-testid="payer-preauth-note" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="payer-preauth-submit" disabled={requesting}
            {...(reference.trim() === '' ? { disabledReason: 'Enter the reference' }
              : patientId.trim() === '' ? { disabledReason: 'Enter the patient id' }
              : payerId.trim() === '' ? { disabledReason: 'Enter the payer id' }
              : serviceCode.trim() === '' ? { disabledReason: 'Enter the service code' } : {})}
            onClick={request}>Request pre-auth</Button>
        </div>
        {reqMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={reqMsg.tone} assertive={reqMsg.tone === 'danger'}>{reqMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="payer-preauth-decide-form">
        <h3 className="scr__section-title">Decide a pre-authorisation</h3>
        <p className="scr__kpi-meta">Record the payer's decision on a requested pre-auth. Approving captures the payer's authorisation code; declining records that cover was refused. A pre-auth can only be decided once.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Pre-auth id" hint="The requested pre-authorisation" data-testid="payer-decide-id" value={preauthId} onChange={(e) => setPreauthId(e.currentTarget.value)} />
          <Field label="Authorisation code" optional hint="The payer's approval code" data-testid="payer-decide-auth" value={authorisation} onChange={(e) => setAuthorisation(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)', gap: 'var(--sancta-space-2)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="payer-decide-approve" disabled={deciding}
            {...(preauthId.trim() === '' ? { disabledReason: 'Enter the pre-auth id' } : {})}
            onClick={() => void decide(true)}>Approve</Button>
          <Button variant="secondary" tone="danger" icon={<Icon name="alert" />} data-testid="payer-decide-decline" disabled={deciding}
            {...(preauthId.trim() === '' ? { disabledReason: 'Enter the pre-auth id' } : {})}
            onClick={() => void decide(false)}>Decline</Button>
        </div>
        {decMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={decMsg.tone} assertive={decMsg.tone === 'danger'}>{decMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
