import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { type Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Severity = 'low' | 'high' | 'critical';
const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];
const SEV_TONE: Record<Severity, 'neutral' | 'warning' | 'danger'> = { low: 'neutral', high: 'warning', critical: 'danger' };

type Recorded = { allergyId: string; substanceCode: string; severity: Severity };

/**
 * Allergy capture (MED-003). Records a coded drug/substance allergy for the patient in
 * context against the gating list the prescriber checks — once committed here, an
 * attempt to prescribe the same substance raises an allergy alert (and, without an
 * explicit override, is blocked). Safety-first: the substance is coded, the severity
 * is an explicit choice with NO silent default, and the write is confirmed-commit
 * (§9.2) — success is shown only once the hub durably accepts it, and a failed write
 * preserves the entry so nothing is lost. Uses POST /api/allergies — the same path and
 * method on both the edge and the Worker. (There is no allergy read endpoint on either
 * backend, so the list below is this session's confirmed commits; the full allergy
 * record gates prescribing on the Prescribe screen.)
 */
export function Allergies({ patient }: { patient: Patient | null }) {
  const [substanceCode, setSubstanceCode] = useState('');
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [busy, setBusy] = useState(false);
  const [recorded, setRecorded] = useState<Recorded[]>([]);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  if (!patient) {
    return <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to record an allergy.</StateBlock>;
  }

  const canSubmit = substanceCode.trim() !== '' && severity !== null;

  const record = async () => {
    if (!canSubmit || severity === null) return;
    setBusy(true); setMsg(null);
    const body = { patientId: patient.id, substanceCode: substanceCode.trim(), severity };
    const res = await mutate<{ allergyId: string }>('/api/allergies', body, { idempotencyKey: newIdempotencyKey() });
    setBusy(false);
    if (res.ok) {
      const allergyId = res.data?.allergyId ?? '(committed)';
      setRecorded((r) => [{ allergyId, substanceCode: substanceCode.trim(), severity }, ...r]);
      setMsg({ tone: 'success', text: `Allergy to ${substanceCode.trim()} recorded (${severity}). It will now alert on prescribing.` });
      setSubstanceCode(''); setSeverity(null);
      return;
    }
    setMsg({ tone: 'danger', text: res.errorCode === 'network'
      ? 'Could not reach the clinic hub — the allergy was NOT recorded; your entry is kept. Retry when connected.'
      : `Could not record the allergy (${res.errorCode ?? 'error'}). Your entry is kept.` });
  };

  return (
    <section className="scr" aria-label={`Record allergy for ${patient.given_name} ${patient.family_name}`}>
      <div className="scr__card" data-testid="alg-form">
        <h3 className="scr__section-title">Record allergy (MED-03)</h3>
        <p className="scr__kpi-meta">For {patient.given_name} {patient.family_name}. A recorded allergy is checked on every prescription.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Substance code" hint="Coded drug or substance, e.g. PENICILLIN" data-testid="alg-substance" value={substanceCode} onChange={(e) => setSubstanceCode(e.currentTarget.value)} />
          <label className="sancta-field">
            <span className="sancta-field__label">Severity</span>
            <select className="sancta-field-input" data-testid="alg-severity" value={severity ?? ''} onChange={(e) => setSeverity(e.currentTarget.value === '' ? null : (e.currentTarget.value as Severity))}>
              <option value="" disabled>Select severity…</option>
              {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>
        {severity === 'critical' && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Banner tone="danger" title="Critical allergy" assertive>A critical allergy is life-threatening. It will block prescribing of this substance unless a prescriber explicitly overrides with a reason.</Banner>
          </div>
        )}
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" {...(severity === 'critical' ? { tone: 'danger' as const } : {})} data-testid="alg-submit" disabled={busy}
            {...(!canSubmit ? { disabledReason: 'Enter a substance code and choose a severity' } : {})}
            onClick={record}>Record allergy</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      <div>
        <h3 className="scr__section-title">Recorded this session</h3>
        {recorded.length === 0
          ? <StateBlock state="empty" title="No allergies recorded yet">Recorded allergies gate prescribing for this patient. The full standing list is applied automatically on the Prescribe screen.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="alg-table">
                <caption className="sancta-visually-hidden">Allergies recorded in this session, newest first</caption>
                <thead><tr><th scope="col">Substance</th><th scope="col">Severity</th><th scope="col">Record</th></tr></thead>
                <tbody>
                  {recorded.map((r) => (
                    <tr key={r.allergyId}>
                      <td>{r.substanceCode}</td>
                      <td><StatusTag tone={SEV_TONE[r.severity]} icon={r.severity === 'critical' ? 'alert' : null}>{r.severity}</StatusTag></td>
                      <td data-numeric>···{r.allergyId.slice(-8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </section>
  );
}
