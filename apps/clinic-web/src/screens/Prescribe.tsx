import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

// In production the prescriber is the authenticated clinician; the demo operator
// holds the clinical role (sign → prescribe).
const PRESCRIBER = 'demo-operator';

type AllergyAlert = { substanceCode: string; severity: string };
type PrescribeOk = { ok: true; requestId: string; overridden: boolean };
type PrescribeBlocked = { ok: false; alerts: AllergyAlert[] };
type PrescribeResponse = PrescribeOk | PrescribeBlocked;

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = { critical: 'danger', high: 'danger', low: 'warning' };

/**
 * Prescribe with allergy checking + controlled override (MED-02/03, MED-003,
 * UAT-05). A prescription is checked against the patient's active allergies by
 * substance; a match BLOCKS it (the hub returns ok:false with the alerts, never a
 * silent pass). To proceed, an authorised prescriber must acknowledge the alert and
 * record an explicit override reason — which is audited (§3.1). Prescribing is a
 * confirmed-commit write (§9.2): success shows only once the hub accepts it, and the
 * draft (including the override reason) is preserved on any failure. The screen only
 * opens with a patient in context. Closes the allergy-override safety scenario.
 */
export function Prescribe({ patient }: { patient: Patient | null }) {
  const [medicineCode, setMedicineCode] = useState('');
  const [substanceCode, setSubstanceCode] = useState('');
  const [dose, setDose] = useState('');
  const [route, setRoute] = useState('');
  const [frequency, setFrequency] = useState('');

  const [alerts, setAlerts] = useState<AllergyAlert[] | null>(null); // set when blocked
  const [overrideReason, setOverrideReason] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  if (!patient) {
    return <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to prescribe. Every prescription is checked against that patient’s recorded allergies.</StateBlock>;
  }

  const canSubmit = medicineCode.trim().length > 0 && substanceCode.trim().length > 0;
  // When an allergy is showing, the override reason is mandatory to proceed.
  const blockedNeedsReason = alerts !== null && !overrideReason.trim();

  const resetForm = () => {
    setMedicineCode(''); setSubstanceCode(''); setDose(''); setRoute(''); setFrequency('');
    setAlerts(null); setOverrideReason(''); setIdemKey(newIdempotencyKey());
  };

  const submit = async () => {
    if (!canSubmit || blockedNeedsReason) return;
    setBusy(true); setMsg(null);
    const override = alerts !== null;
    const res = await mutate<PrescribeResponse>(
      '/api/prescribe',
      {
        patientId: patient.id, medicineCode: medicineCode.trim(), substanceCode: substanceCode.trim(),
        ...(dose.trim() ? { dose: dose.trim() } : {}),
        ...(route.trim() ? { route: route.trim() } : {}),
        ...(frequency.trim() ? { frequency: frequency.trim() } : {}),
        prescribedBy: PRESCRIBER,
        ...(override ? { override: true, overrideReason: overrideReason.trim() } : {}),
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);

    if (res.ok && res.data && res.data.ok) {
      setMsg({ tone: res.data.overridden ? 'warning' : 'success',
        text: res.data.overridden
          ? `Prescribed over a recorded allergy alert — the override reason is saved and audited. Request ···${res.data.requestId.slice(-8)}.`
          : `Prescribed and saved to the clinic. Request ···${res.data.requestId.slice(-8)}.` });
      resetForm();
    } else if (res.status === 409 && res.data && res.data.ok === false && Array.isArray(res.data.alerts)) {
      // Allergy block — surface the alert and require an explicit override reason.
      setAlerts(res.data.alerts);
      setMsg({ tone: 'danger', text: 'Allergy alert — this prescription is blocked. Review the alert below; to proceed you must record an override reason.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was prescribed — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Prescription blocked (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Prescribe medication">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">New prescription (MED-03)</h3>
        <StatusTag tone={alerts ? 'danger' : 'neutral'} icon={alerts ? 'alert' : null}>
          {alerts ? 'Allergy alert — override required' : 'Allergy-checked on submit'}
        </StatusTag>
      </div>

      <div className="scr__card" data-testid="rx-form">
        <div className="scr__form-grid">
          <Field label="Medicine code" hint="Formulary code of the product" data-testid="rx-medicine" value={medicineCode} onChange={(e) => setMedicineCode(e.currentTarget.value)} />
          <Field label="Substance code" hint="Active substance — checked against allergies" data-testid="rx-substance" value={substanceCode} onChange={(e) => setSubstanceCode(e.currentTarget.value)} />
          <Field label="Dose" optional data-testid="rx-dose" value={dose} onChange={(e) => setDose(e.currentTarget.value)} />
          <Field label="Route" optional hint="e.g. oral, IV, IM" data-testid="rx-route" value={route} onChange={(e) => setRoute(e.currentTarget.value)} />
          <Field label="Frequency" optional hint="e.g. BD, TDS, once daily" data-testid="rx-frequency" value={frequency} onChange={(e) => setFrequency(e.currentTarget.value)} />
        </div>

        {alerts && (
          <div style={{ marginTop: 'var(--sancta-space-4)' }}>
            <Banner tone="danger" title="Recorded allergy for this patient" assertive>
              Prescribing this substance conflicts with an active allergy. Overriding is a clinical decision that will be recorded against your name.
            </Banner>
            <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-2)' }}>
              <table className="scr__table" data-testid="rx-alerts">
                <caption className="sancta-visually-hidden">Active allergies matching the prescribed substance</caption>
                <thead><tr><th scope="col">Substance</th><th scope="col">Severity</th></tr></thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.substanceCode}>
                      <td>{a.substanceCode}</td>
                      <td><StatusTag tone={SEVERITY_TONE[a.severity] ?? 'warning'} icon="alert">{a.severity}</StatusTag></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 'var(--sancta-space-3)' }}>
              <Field label="Override reason" hint="Required — the clinical justification for prescribing despite the allergy" data-testid="rx-override-reason"
                value={overrideReason} onChange={(e) => setOverrideReason(e.currentTarget.value)} />
            </div>
          </div>
        )}

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone={alerts ? 'danger' : 'action'} data-testid="rx-submit" disabled={busy}
            {...(!canSubmit ? { disabledReason: 'Enter a medicine and substance code' } : blockedNeedsReason ? { disabledReason: 'Record an override reason to prescribe over the allergy' } : {})}
            onClick={submit}>{alerts ? 'Override & prescribe' : 'Prescribe'}</Button>
          {alerts && <Button variant="subtle" data-testid="rx-cancel" disabled={busy} onClick={resetForm}>Cancel</Button>}
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
