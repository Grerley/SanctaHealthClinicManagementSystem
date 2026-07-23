import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const RECORDED_BY = 'demo-operator';

// Vital-sign ranges MIRROR packages/domain/src/vitals.ts. This client copy drives
// advisory, live in-form flags only — the clinic hub RE-VALIDATES on submit and is
// the authoritative gate (an implausible value is rejected there unless confirmed).
// [hard = implausible outlier · soft = clinical reference].
type Range = { min: number; max: number };
type VitalKind = 'temperature_c' | 'systolic_bp' | 'diastolic_bp' | 'pulse_bpm' | 'respiratory_rate' | 'spo2_pct' | 'weight_kg' | 'height_cm' | 'glucose_mmol';
const VITALS: Array<{ kind: VitalKind; label: string; unit: string; hard: Range; soft: Range; step?: number }> = [
  { kind: 'temperature_c', label: 'Temperature', unit: '°C', hard: { min: 25, max: 45 }, soft: { min: 36, max: 37.5 }, step: 0.1 },
  { kind: 'systolic_bp', label: 'Systolic BP', unit: 'mmHg', hard: { min: 40, max: 300 }, soft: { min: 90, max: 140 } },
  { kind: 'diastolic_bp', label: 'Diastolic BP', unit: 'mmHg', hard: { min: 20, max: 200 }, soft: { min: 60, max: 90 } },
  { kind: 'pulse_bpm', label: 'Pulse', unit: 'bpm', hard: { min: 20, max: 300 }, soft: { min: 60, max: 100 } },
  { kind: 'respiratory_rate', label: 'Respiratory rate', unit: '/min', hard: { min: 4, max: 80 }, soft: { min: 12, max: 20 } },
  { kind: 'spo2_pct', label: 'SpO₂', unit: '%', hard: { min: 40, max: 100 }, soft: { min: 94, max: 100 } },
  { kind: 'weight_kg', label: 'Weight', unit: 'kg', hard: { min: 0.3, max: 400 }, soft: { min: 2, max: 200 }, step: 0.1 },
  { kind: 'height_cm', label: 'Height', unit: 'cm', hard: { min: 20, max: 260 }, soft: { min: 40, max: 210 } },
  { kind: 'glucose_mmol', label: 'Glucose', unit: 'mmol/L', hard: { min: 0.5, max: 60 }, soft: { min: 4, max: 7.8 }, step: 0.1 },
];

type Flag = 'ok' | 'out_of_reference' | 'implausible';
function flagOf(v: (typeof VITALS)[number], value: number): Flag {
  if (value < v.hard.min || value > v.hard.max) return 'implausible';
  if (value < v.soft.min || value > v.soft.max) return 'out_of_reference';
  return 'ok';
}
const FLAG_TONE: Record<Flag, 'success' | 'warning' | 'danger'> = { ok: 'success', out_of_reference: 'warning', implausible: 'danger' };
const FLAG_LABEL: Record<Flag, string> = { ok: 'In range', out_of_reference: 'Outside reference', implausible: 'Implausible — confirm' };

/**
 * Triage vitals capture with plausible-range validation (TRI-02/03, UAT-03). Each
 * value is checked against two bands: a soft clinical reference (flagged amber, still
 * recorded) and a hard implausible band (flagged red). An implausible value is never
 * silently dropped OR silently accepted — it must be explicitly confirmed as correct
 * before the set can be saved, and the confirmation is carried to the hub, which
 * re-validates and rejects an unconfirmed outlier authoritatively (§3.1). Recording
 * is a confirmed-commit write (§9.2); the entered values are preserved on any failure.
 * Opens only with a patient in context.
 */
export function Vitals({ patient }: { patient: Patient | null }) {
  const [values, setValues] = useState<Partial<Record<VitalKind, string>>>({});
  const [confirmImplausible, setConfirmImplausible] = useState(false);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  if (!patient) {
    return <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to record vitals. Observations are always attributed to a named patient.</StateBlock>;
  }

  const entered = VITALS
    .map((v) => { const raw = values[v.kind]; const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw); return { v, n }; })
    .filter((x) => Number.isFinite(x.n))
    .map((x) => ({ ...x, flag: flagOf(x.v, x.n) }));

  const hasImplausible = entered.some((e) => e.flag === 'implausible');
  const nothingEntered = entered.length === 0;
  const blocked = nothingEntered || (hasImplausible && !confirmImplausible);

  const setValue = (kind: VitalKind, raw: string) => setValues((prev) => ({ ...prev, [kind]: raw }));

  const submit = async () => {
    if (blocked) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ encounterId: string; observations: unknown[] }>(
      '/api/triage/vitals',
      { patientId: patient.id, vitals: entered.map((e) => ({ kind: e.v.kind, value: e.n })), confirmed: hasImplausible ? true : undefined, user: RECORDED_BY },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok) {
      const abn = entered.filter((e) => e.flag !== 'ok').length;
      setMsg({ tone: abn > 0 ? 'warning' : 'success',
        text: `Recorded ${entered.length} observation${entered.length === 1 ? '' : 's'} for ${patient.given_name} ${patient.family_name}${abn > 0 ? ` — ${abn} outside the reference range and flagged in the record.` : '.'}` });
      setValues({}); setConfirmImplausible(false); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'vitals_need_confirmation') {
      setMsg({ tone: 'danger', text: 'The hub flagged an implausible value. Confirm the unusual values are correct, then record again.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was recorded — your entries are kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not record vitals (${res.errorCode ?? 'error'}). Your entries are kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Vitals capture">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Record vitals (TRI-03)</h3>
        <StatusTag tone={hasImplausible ? 'danger' : entered.some((e) => e.flag === 'out_of_reference') ? 'warning' : 'neutral'} icon={hasImplausible ? 'alert' : null}>
          {hasImplausible ? 'Implausible value — confirm to save' : 'Range-checked as you type'}
        </StatusTag>
      </div>

      <div className="scr__card" data-testid="vitals-form">
        <div className="scr__form-grid">
          {VITALS.map((v) => {
            const raw = values[v.kind] ?? '';
            const n = raw.trim() === '' ? NaN : Number(raw);
            const flag: Flag | null = Number.isFinite(n) ? flagOf(v, n) : null;
            return (
              <div key={v.kind}>
                <Field
                  label={v.label} numeric optional suffix={v.unit} data-testid={`vitals-${v.kind}`}
                  {...(v.step ? { step: v.step } : {})}
                  value={raw}
                  onChange={(e) => setValue(v.kind, e.currentTarget.value)}
                  {...(flag === 'implausible' ? { error: `Outside the plausible range ${v.hard.min}–${v.hard.max}${v.unit}` } : {})}
                />
                {flag && flag !== 'ok' && (
                  <div style={{ marginTop: 'var(--sancta-space-1)' }}>
                    <StatusTag tone={FLAG_TONE[flag]} icon={flag === 'implausible' ? 'alert' : null}>{FLAG_LABEL[flag]}</StatusTag>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {hasImplausible && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Banner tone="danger" title="One or more values are outside the plausible range" assertive>
              These are almost always a data-entry slip. Correct them, or confirm they are genuinely correct before saving.
            </Banner>
            <label className="scr__attest" data-testid="vitals-confirm-wrap" style={{ marginTop: 'var(--sancta-space-2)' }}>
              <input type="checkbox" data-testid="vitals-confirm" checked={confirmImplausible} onChange={(e) => setConfirmImplausible(e.currentTarget.checked)} />
              <span>I have re-checked the flagged values and confirm they are correct for this patient.</span>
            </label>
          </div>
        )}

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="vitals-submit" disabled={busy}
            {...(nothingEntered ? { disabledReason: 'Enter at least one vital sign' } : (hasImplausible && !confirmImplausible) ? { disabledReason: 'Confirm the implausible values are correct before saving' } : {})}
            onClick={submit}>Record vitals</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
