import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const USER = 'demo-operator';

type VitalField = { kind: string; label: string; unit: string };
const VITAL_FIELDS: VitalField[] = [
  { kind: 'temperature_c', label: 'Temperature', unit: '°C' },
  { kind: 'systolic_bp', label: 'Systolic BP', unit: 'mmHg' },
  { kind: 'diastolic_bp', label: 'Diastolic BP', unit: 'mmHg' },
  { kind: 'pulse_bpm', label: 'Pulse', unit: 'bpm' },
  { kind: 'respiratory_rate', label: 'Respiratory rate', unit: '/min' },
  { kind: 'spo2_pct', label: 'SpO₂', unit: '%' },
  { kind: 'weight_kg', label: 'Weight', unit: 'kg' },
  { kind: 'glucose_mmol', label: 'Glucose', unit: 'mmol/L' },
];

type Observation = { kind: string; value: number; unit: string; flag: string; requiresConfirmation: boolean; message?: string };
type VitalsOut = { encounterId: string; visitId: string; observations: Observation[] };
type AssessmentOut = { assessmentId: string; dangerSigns: Array<{ code?: string; label?: string } | string>; ews: { score: number; band: string } };

const FLAG_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = { ok: 'neutral', out_of_reference: 'warning', implausible: 'danger' };

/**
 * Triage intake (TRI-001/002/003) for the patient in context. Records a validated set
 * of vitals — an implausible value is never silently dropped; it is re-presented for
 * confirmation and only then recorded (TRI-003). Recording opens the triage encounter;
 * its id then carries the assessment (danger signs + early-warning score computed by
 * the backend, TRI-004/005) and any nursing intervention (TRI-006). Every step is a
 * confirmed-commit write (§9.2) and keeps its draft on failure. Once assessed, the
 * patient appears in the Triage queue for sign-off.
 */
export function TriageIntake({ patient }: { patient: Patient | null }) {
  const [vitals, setVitals] = useState<Record<string, string>>({});
  const [vKey, setVKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [vMsg, setVMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [encounter, setEncounter] = useState<VitalsOut | null>(null);

  const [reason, setReason] = useState('');
  const [pain, setPain] = useState('');
  const [allergyReviewed, setAllergyReviewed] = useState(false);
  const [aKey, setAKey] = useState(newIdempotencyKey());
  const [aMsg, setAMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [assessed, setAssessed] = useState(false);

  const [ivKind, setIvKind] = useState('');
  const [ivDetail, setIvDetail] = useState('');
  const [ivResponse, setIvResponse] = useState('');
  const [ivKey, setIvKey] = useState(newIdempotencyKey());
  const [ivMsg, setIvMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  if (!patient) {
    return <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to record triage. Every reading is attributed to a named patient.</StateBlock>;
  }

  const vitalInputs = () => VITAL_FIELDS
    .map((f) => ({ kind: f.kind, value: Number(vitals[f.kind]) }))
    .filter((v) => vitals[v.kind]?.trim() && Number.isFinite(v.value));

  const recordVitals = async (confirmed: boolean) => {
    const inputs = vitalInputs();
    if (inputs.length === 0) return;
    setBusy(true); setVMsg(null);
    const res = await mutate<VitalsOut>(
      '/api/triage/vitals',
      { patientId: patient.id, vitals: inputs, ...(confirmed ? { confirmed: true } : {}), user: USER },
      { idempotencyKey: vKey },
    );
    setBusy(false);
    if (res.ok && res.data?.encounterId) {
      setEncounter(res.data); setNeedsConfirm(false);
      const flagged = res.data.observations.filter((o) => o.flag !== 'ok');
      setVMsg({ tone: flagged.length > 0 ? 'warning' : 'success',
        text: `Vitals recorded — triage encounter opened (···${res.data.encounterId.slice(-8)}).${flagged.length > 0 ? ` ${flagged.length} value(s) flagged.` : ''} Record the assessment below.` });
    } else if (res.errorCode === 'vitals_need_confirmation') {
      setNeedsConfirm(true);
      setVMsg({ tone: 'danger', text: 'One or more values are outside the plausible range. Nothing was recorded — your entries are kept. Correct them, or confirm the readings are accurate to record them as entered.' });
    } else if (res.errorCode === 'network') {
      setVMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was recorded — your entries are kept; retry when connected.' });
    } else {
      setVMsg({ tone: 'danger', text: `Could not record vitals (${res.errorCode ?? 'error'}). Your entries are kept.` });
    }
  };

  const painNum = pain.trim() === '' ? undefined : Number(pain);
  const canAssess = reason.trim().length > 0 && (painNum === undefined || (Number.isFinite(painNum) && painNum >= 0 && painNum <= 10));

  const recordAssessment = async () => {
    if (!encounter || !canAssess) return;
    setBusy(true); setAMsg(null);
    const res = await mutate<AssessmentOut>(
      '/api/triage/assessment',
      { encounterId: encounter.encounterId, reason: reason.trim(), allergyReviewed,
        ...(painNum !== undefined ? { painScore: painNum } : {}), user: USER },
      { idempotencyKey: aKey },
    );
    setBusy(false);
    if (res.ok && res.data?.assessmentId) {
      setAssessed(true);
      const { ews, dangerSigns } = res.data;
      setAMsg({ tone: dangerSigns.length > 0 || ews.band === 'high' ? 'warning' : 'success',
        text: `Assessment recorded. Early-warning score ${ews.score} (${ews.band}); ${dangerSigns.length} danger sign(s). The patient is now in the Triage queue for sign-off.` });
    } else if (res.errorCode === 'network') {
      setAMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was recorded — your entries are kept; retry when connected.' });
    } else {
      setAMsg({ tone: 'danger', text: `Could not record the assessment (${res.errorCode ?? 'error'}). Your entries are kept.` });
    }
  };

  const recordIntervention = async () => {
    if (!encounter || !ivKind.trim()) return;
    setBusy(true); setIvMsg(null);
    const res = await mutate<{ interventionId: string }>(
      '/api/triage/intervention',
      { encounterId: encounter.encounterId, kind: ivKind.trim(),
        ...(ivDetail.trim() ? { detail: ivDetail.trim() } : {}), ...(ivResponse.trim() ? { response: ivResponse.trim() } : {}), user: USER },
      { idempotencyKey: ivKey },
    );
    setBusy(false);
    if (res.ok && res.data?.interventionId) {
      setIvMsg({ tone: 'success', text: `Intervention "${ivKind.trim()}" recorded.` });
      setIvKind(''); setIvDetail(''); setIvResponse(''); setIvKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setIvMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was recorded — your entry is kept; retry when connected.' });
    } else {
      setIvMsg({ tone: 'danger', text: `Could not record the intervention (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Triage intake">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Triage intake (TRI-002) — {patient.family_name}, {patient.given_name}</h3>
        <StatusTag tone={encounter ? 'success' : 'neutral'} icon={encounter ? 'check' : null}>{encounter ? 'Encounter open' : 'Vitals first'}</StatusTag>
      </div>

      <div className="scr__card" data-testid="ti-vitals">
        <h3 className="scr__section-title">Vitals</h3>
        <p className="scr__kpi-meta">Enter the readings taken. Leave a field blank to skip it. Implausible values are re-presented for confirmation, never dropped.</p>
        <div className="scr__form-grid">
          {VITAL_FIELDS.map((f) => (
            <Field key={f.kind} label={f.label} optional numeric suffix={f.unit} data-testid={`ti-v-${f.kind}`}
              value={vitals[f.kind] ?? ''} onChange={(e) => setVitals((p) => ({ ...p, [f.kind]: e.currentTarget.value }))} />
          ))}
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="ti-record" disabled={busy || Boolean(encounter)}
            {...(vitalInputs().length === 0 ? { disabledReason: 'Enter at least one reading' } : {})}
            onClick={() => recordVitals(false)}>Record vitals</Button>
          {needsConfirm && (
            <Button variant="secondary" tone="danger" data-testid="ti-confirm" disabled={busy} onClick={() => recordVitals(true)}>Confirm readings and record</Button>
          )}
        </div>
        {vMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={vMsg.tone} assertive={vMsg.tone !== 'success'}>{vMsg.text}</Banner></div>}
        {encounter && encounter.observations.some((o) => o.flag !== 'ok') && (
          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <table className="scr__table" data-testid="ti-flags">
              <caption className="sancta-visually-hidden">Recorded vitals that fell outside the reference or plausible range.</caption>
              <thead><tr><th scope="col">Vital</th><th scope="col">Value</th><th scope="col">Flag</th></tr></thead>
              <tbody>
                {encounter.observations.filter((o) => o.flag !== 'ok').map((o) => (
                  <tr key={o.kind}><td>{o.kind}</td><td data-numeric>{o.value} {o.unit}</td>
                    <td><StatusTag tone={FLAG_TONE[o.flag] ?? 'neutral'} icon={o.flag === 'implausible' ? 'alert' : null}>{o.flag.replace('_', ' ')}</StatusTag></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {encounter && (
        <div className="scr__card" data-testid="ti-assessment">
          <h3 className="scr__section-title">Assessment</h3>
          <p className="scr__kpi-meta">Danger signs and the early-warning score are computed by the clinic from the recorded vitals — decision support, not a diagnosis.</p>
          <div className="scr__form-grid">
            <Field label="Presenting reason" data-testid="ti-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
            <Field label="Pain score" optional numeric hint="0–10" data-testid="ti-pain" value={pain} onChange={(e) => setPain(e.currentTarget.value)} />
          </div>
          <label className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-2)' }}>
            <input type="checkbox" data-testid="ti-allergy" checked={allergyReviewed} onChange={(e) => setAllergyReviewed(e.currentTarget.checked)} />
            <span>Allergies reviewed</span>
          </label>
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" data-testid="ti-assess" disabled={busy}
              {...(!canAssess ? { disabledReason: reason.trim() ? 'Pain score must be 0–10' : 'Enter a presenting reason' } : {})}
              onClick={recordAssessment}>Record assessment</Button>
          </div>
          {aMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={aMsg.tone} assertive={aMsg.tone !== 'success'}>{aMsg.text}</Banner></div>}
        </div>
      )}

      {assessed && encounter && (
        <div className="scr__card" data-testid="ti-intervention">
          <h3 className="scr__section-title">Nursing intervention (optional)</h3>
          <div className="scr__form-grid">
            <Field label="Intervention" hint="e.g. paracetamol, oxygen, wound dressing" data-testid="ti-iv-kind" value={ivKind} onChange={(e) => setIvKind(e.currentTarget.value)} />
            <Field label="Detail" optional data-testid="ti-iv-detail" value={ivDetail} onChange={(e) => setIvDetail(e.currentTarget.value)} />
            <Field label="Response" optional data-testid="ti-iv-response" value={ivResponse} onChange={(e) => setIvResponse(e.currentTarget.value)} />
          </div>
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="secondary" data-testid="ti-iv-record" disabled={busy}
              {...(!ivKind.trim() ? { disabledReason: 'Enter an intervention' } : {})}
              onClick={recordIntervention}>Record intervention</Button>
          </div>
          {ivMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={ivMsg.tone} assertive={ivMsg.tone === 'danger'}>{ivMsg.text}</Banner></div>}
        </div>
      )}
    </section>
  );
}
