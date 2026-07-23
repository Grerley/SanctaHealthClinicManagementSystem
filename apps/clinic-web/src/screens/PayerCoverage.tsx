import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Coverage = { coverageId: string; payer: string; memberNumber: string; plan: string | null; priority: number };
type Eligibility = { eligible: boolean; coverages: Coverage[] };

function isoToday(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Coverage & eligibility (BIL-011). The eligibility panel derives active coverage
 * for a patient as-of a date (a read scoped by patientId + date, safe to re-query);
 * the form below records a new coverage for a patient against a payer. Recording a
 * coverage is a confirmed-commit write (§9.2) — the draft is preserved on failure —
 * and re-checks eligibility for the same patient on success so the new row appears.
 */
export function PayerCoverage({ patient }: { patient: Patient | null }) {
  const prefill = patient?.id ?? '';

  // Eligibility check.
  const [checkPatient, setCheckPatient] = useState(prefill);
  const [asOf, setAsOf] = useState(isoToday());
  const [result, setResult] = useState<Eligibility | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // Coverage draft.
  const [patientId, setPatientId] = useState(prefill);
  const [payerId, setPayerId] = useState('');
  const [memberNumber, setMemberNumber] = useState('');
  const [plan, setPlan] = useState('');
  const [priority, setPriority] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(isoToday());
  const [effectiveTo, setEffectiveTo] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const check = useCallback(async (pid: string, d: string) => {
    if (pid.trim() === '') { setState('idle'); setResult(null); return; }
    setState('loading');
    try {
      const r = await jsonFetch<Eligibility>(`/api/payer/eligibility?patientId=${encodeURIComponent(pid.trim())}&asOf=${encodeURIComponent(d)}`);
      setResult(r); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { if (prefill !== '') void check(prefill, asOf); }, [check]); // eslint-disable-line react-hooks/exhaustive-deps

  const addCoverage = async () => {
    if (patientId.trim() === '' || payerId.trim() === '' || memberNumber.trim() === '' || effectiveFrom.trim() === '') return;
    const prio = priority.trim();
    const prioValid = prio === '' || Number.isFinite(Number(prio));
    if (!prioValid) { setMsg({ tone: 'danger', text: 'Priority must be a whole number (1 = primary).' }); return; }
    setSaving(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/payer/coverage',
      {
        patientId: patientId.trim(),
        payerId: payerId.trim(),
        memberNumber: memberNumber.trim(),
        effectiveFrom,
        ...(plan.trim() ? { plan: plan.trim() } : {}),
        ...(prio ? { priority: Number(prio) } : {}),
        ...(effectiveTo.trim() ? { effectiveTo } : {}),
      },
      { idempotencyKey: idem },
    );
    setSaving(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `Coverage recorded. Coverage id ···${res.data.id.slice(-8)}.` });
      setMemberNumber(''); setPlan(''); setPriority(''); setEffectiveTo(''); setIdem(newIdempotencyKey());
      if (patientId.trim() === checkPatient.trim() || checkPatient.trim() === '') {
        setCheckPatient(patientId.trim());
        try { await check(patientId.trim(), asOf); } catch { /* connectivity indicator covers this */ }
      }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not record the coverage (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Coverage and eligibility">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Eligibility (BIL-011)</h3>
            <Field label="Patient id" hint="Whose coverage to check" data-testid="payer-elig-patient" value={checkPatient} onChange={(e) => setCheckPatient(e.currentTarget.value)} />
            <Field label="As of" type="date" hint="Active on this date" data-testid="payer-elig-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="payer-elig-check" disabled={state === 'loading'}
              {...(checkPatient.trim() === '' ? { disabledReason: 'Enter a patient id to check' } : {})}
              onClick={() => void check(checkPatient, asOf)}>Check</Button>
          </div>
          {state === 'ready' && result && (
            <StatusTag tone={result.eligible ? 'success' : 'warning'} icon={result.eligible ? 'check' : 'alert'}>
              {result.eligible ? `${result.coverages.length} active` : 'No active coverage'}
            </StatusTag>
          )}
        </div>
        {state === 'idle' && <StateBlock state="empty" title="No patient checked">Enter a patient id and check to see active coverage.</StateBlock>}
        {state === 'loading' && <StateBlock state="initial-loading" title="Checking eligibility" />}
        {state === 'error' && <StateBlock state="stale" title="Eligibility unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && result && (
          result.coverages.length === 0
            ? <StateBlock state="empty" title="No active coverage">This patient has no active coverage on the selected date.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="payer-elig-table">
                  <caption className="sancta-visually-hidden">Active coverage for the patient as of the selected date, primary first</caption>
                  <thead><tr><th scope="col">Payer</th><th scope="col">Member number</th><th scope="col">Plan</th><th scope="col">Priority</th></tr></thead>
                  <tbody>
                    {result.coverages.map((c) => (
                      <tr key={c.coverageId}>
                        <td>{c.payer}</td>
                        <td>{c.memberNumber}</td>
                        <td>{c.plan ?? '—'}</td>
                        <td data-numeric>
                          <StatusTag tone={c.priority === 1 ? 'success' : 'neutral'} icon={null}>{c.priority === 1 ? 'Primary' : `Priority ${c.priority}`}</StatusTag>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="payer-coverage-form">
        <h3 className="scr__section-title">Record coverage</h3>
        <p className="scr__kpi-meta">Link a patient to a payer scheme. Priority 1 is the primary payer; effective dates bound when the coverage is active. A recorded coverage surfaces in the eligibility panel above.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Patient id" hint="Who is covered" data-testid="payer-cov-patient" value={patientId} onChange={(e) => setPatientId(e.currentTarget.value)} />
          <Field label="Payer id" hint="The registered payer" data-testid="payer-cov-payer" value={payerId} onChange={(e) => setPayerId(e.currentTarget.value)} />
          <Field label="Member number" hint="The patient's membership id" data-testid="payer-cov-member" value={memberNumber} onChange={(e) => setMemberNumber(e.currentTarget.value)} />
          <Field label="Plan" optional hint="Scheme plan or tier" data-testid="payer-cov-plan" value={plan} onChange={(e) => setPlan(e.currentTarget.value)} />
          <Field label="Priority" optional numeric hint="1 = primary payer" data-testid="payer-cov-priority" value={priority} onChange={(e) => setPriority(e.currentTarget.value)} />
          <Field label="Effective from" type="date" hint="Coverage start date" data-testid="payer-cov-from" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.currentTarget.value)} />
          <Field label="Effective to" optional type="date" hint="Coverage end date" data-testid="payer-cov-to" value={effectiveTo} onChange={(e) => setEffectiveTo(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="payer-cov-submit" disabled={saving}
            {...(patientId.trim() === '' ? { disabledReason: 'Enter the patient id' }
              : payerId.trim() === '' ? { disabledReason: 'Enter the payer id' }
              : memberNumber.trim() === '' ? { disabledReason: 'Enter the member number' }
              : effectiveFrom.trim() === '' ? { disabledReason: 'Enter the effective-from date' } : {})}
            onClick={addCoverage}>Record coverage</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
