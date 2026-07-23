import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { type Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * Restricted-record access & break-glass (PAT-009). Opening a sensitive record is a
 * domain decision, and any sensitive/break-glass access is audited so it is
 * accountable. This screen requests access for the patient in context with a stated
 * purpose; break-glass requires an explicit reason and is visibly distinguished from
 * a routine view (not colour alone). The request is a confirmed-commit write (§9.2):
 * on success the hub returns the record sensitivity and whether break-glass applied,
 * and it has written an audit event; on failure the operator’s entry is preserved.
 * /api/patients/access exists on the worker and edge backends.
 */
type AccessResult = { allowed: boolean; sensitivity: string; breakGlass: boolean };
const SENS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = { normal: 'neutral', sensitive: 'warning', restricted: 'danger' };

export function PatientAccess({ patient }: { patient: Patient | null }) {
  const [purpose, setPurpose] = useState('');
  const [breakGlass, setBreakGlass] = useState(false);
  const [reason, setReason] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AccessResult | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const request = async () => {
    if (!patient) return;
    setBusy(true); setMsg(null); setResult(null);
    const res = await mutate<AccessResult>(
      '/api/patients/access',
      {
        patientId: patient.id,
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        ...(breakGlass ? { breakGlass: true, breakGlassReason: reason.trim() } : {}),
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data) {
      setResult(res.data);
      setMsg({ tone: 'success', text: res.data.breakGlass ? 'Break-glass access granted and audited.' : 'Access granted and recorded.' });
      setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. No access was granted — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Access was not granted (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  if (!patient) {
    return <StateBlock state="permission-limited" title="No patient in context">Select a patient from the Patients screen to request access to their record.</StateBlock>;
  }

  const needsReason = breakGlass && reason.trim() === '';

  return (
    <section className="scr" data-testid="access" aria-label={`Record access for ${patient.given_name} ${patient.family_name}`}>
      <div className="scr__card" data-testid="access-form">
        <h3 className="scr__section-title">Request record access (PAT-009)</h3>
        <p className="scr__kpi-meta">Requesting access to {patient.given_name} {patient.family_name}’s record ({patient.mrn}). Sensitive or break-glass access is audited.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Purpose of access" optional hint="Why the record is being opened (care, billing, admin)" data-testid="access-purpose" value={purpose} onChange={(e) => setPurpose(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <label style={{ display: 'flex', gap: 'var(--sancta-space-2)', alignItems: 'center' }}>
            <input type="checkbox" data-testid="access-breakglass" checked={breakGlass} onChange={(e) => setBreakGlass(e.currentTarget.checked)} /> Break-glass (override restriction)
          </label>
        </div>
        {breakGlass && (
          <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Field label="Break-glass reason" hint="Required — justifies overriding the record’s restriction" data-testid="access-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          </div>
        )}
        <div className="scr__row" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone={breakGlass ? 'danger' : 'action'} data-testid="access-submit" disabled={busy}
            {...(needsReason ? { disabledReason: 'Enter a break-glass reason first' } : {})}
            onClick={request}>{breakGlass ? 'Break-glass access' : 'Request access'}</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      {result && (
        <div data-testid="access-result">
          <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
            <h3 className="scr__section-title">Access decision</h3>
            <StatusTag tone={SENS_TONE[result.sensitivity] ?? 'neutral'} icon={result.sensitivity === 'normal' ? 'check' : 'lock'}>
              {`${result.sensitivity} record`}
            </StatusTag>
          </div>
          <ul className="scr__list">
            <li><div className="scr__list-btn" style={{ cursor: 'default', display: 'flex', gap: 'var(--sancta-space-3)', alignItems: 'center' }}>
              <StatusTag tone="success" icon="check">Access granted</StatusTag>
              {result.breakGlass
                ? <StatusTag tone="danger" icon="alert">Break-glass — audited</StatusTag>
                : <StatusTag tone="neutral">Routine view</StatusTag>}
            </div></li>
          </ul>
        </div>
      )}
    </section>
  );
}
