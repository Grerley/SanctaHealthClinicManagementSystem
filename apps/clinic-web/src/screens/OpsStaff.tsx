import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type CredentialCheck = { valid: boolean; reason?: 'expired' | 'inactive' | 'no_credential' };

function isoToday(): string { return new Date().toISOString().slice(0, 10); }

const REASON_TEXT: Record<NonNullable<CredentialCheck['reason']>, string> = {
  expired: 'Credential has expired',
  inactive: 'Staff member is inactive',
  no_credential: 'No credential on record',
};

/**
 * Staff register + credential check (OPS-001). The credential check is a per-staff
 * read scoped by staff id + an as-of DATE — it returns whether the member may
 * perform a credentialed clinical action, and the reason when they may not (an
 * expired credential can block configured clinical actions). Adding a staff member
 * is a confirmed-commit write (§9.2): success only on res.ok, the draft is preserved
 * on failure.
 */
export function OpsStaff() {
  // Credential check.
  const [staffId, setStaffId] = useState('');
  const [asOf, setAsOf] = useState(isoToday());
  const [check, setCheck] = useState<CredentialCheck | null>(null);
  const [checkState, setCheckState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // Add-staff draft.
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('');
  const [registrationNo, setRegistrationNo] = useState('');
  const [credentialExpiry, setCredentialExpiry] = useState('');
  const [addIdem, setAddIdem] = useState(newIdempotencyKey());
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const runCheck = async () => {
    if (staffId.trim() === '') return;
    setCheckState('loading'); setCheck(null);
    try {
      const r = await jsonFetch<CredentialCheck>(`/api/ops/credential?staffId=${encodeURIComponent(staffId.trim())}&asOf=${encodeURIComponent(asOf)}`);
      setCheck(r); setCheckState('ready');
    } catch { setCheckState('error'); }
  };

  const addStaff = async () => {
    if (fullName.trim() === '' || role.trim() === '') return;
    setAdding(true); setAddMsg(null);
    const res = await mutate<{ staffId: string }>(
      '/api/ops/staff',
      {
        fullName: fullName.trim(),
        role: role.trim(),
        ...(registrationNo.trim() ? { registrationNo: registrationNo.trim() } : {}),
        ...(credentialExpiry.trim() ? { credentialExpiry } : {}),
      },
      { idempotencyKey: addIdem },
    );
    setAdding(false);
    if (res.ok && res.data?.staffId) {
      setAddMsg({ tone: 'success', text: `Added ${fullName.trim()} (${role.trim()}). Staff id ···${res.data.staffId.slice(-8)}.` });
      setFullName(''); setRole(''); setRegistrationNo(''); setCredentialExpiry(''); setAddIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setAddMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setAddMsg({ tone: 'danger', text: `Could not add the staff member (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Staff and credentials">
      <div className="scr__card" data-testid="ops-credential-form">
        <h3 className="scr__section-title">Check a credential (OPS-001)</h3>
        <p className="scr__kpi-meta">Whether a staff member may perform a credentialed clinical action as of a date. An expired or missing credential blocks configured clinical actions.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Staff id" hint="The staff member to check" data-testid="ops-credential-staff" value={staffId} onChange={(e) => setStaffId(e.currentTarget.value)} />
          <Field label="As of" type="date" hint="Date of the intended action" data-testid="ops-credential-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="ops-credential-submit" disabled={checkState === 'loading'}
            {...(staffId.trim() === '' ? { disabledReason: 'Enter the staff id' } : {})}
            onClick={runCheck}>Check credential</Button>
        </div>
        {checkState === 'loading' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="initial-loading" title="Checking" /></div>}
        {checkState === 'error' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="stale" title="Check unavailable">The clinic hub may be unreachable, or the staff member was not found.</StateBlock></div>}
        {checkState === 'ready' && check && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }} data-testid="ops-credential-result">
            <StatusTag tone={check.valid ? 'success' : 'danger'} icon={check.valid ? 'check' : 'alert'}>
              {check.valid ? `Valid as of ${asOf}` : `Blocked · ${check.reason ? REASON_TEXT[check.reason] : 'not permitted'}`}
            </StatusTag>
          </div>
        )}
      </div>

      <div className="scr__card" data-testid="ops-staff-form">
        <h3 className="scr__section-title">Add a staff member</h3>
        <p className="scr__kpi-meta">Register a staff member with their role. A registration number and credential expiry let the credential check above enforce clinical actions.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Full name" hint="Staff member's name" data-testid="ops-staff-name" value={fullName} onChange={(e) => setFullName(e.currentTarget.value)} />
          <Field label="Role" hint="e.g. nurse, clinician" data-testid="ops-staff-role" value={role} onChange={(e) => setRole(e.currentTarget.value)} />
          <Field label="Registration no" optional hint="Professional registration" data-testid="ops-staff-regno" value={registrationNo} onChange={(e) => setRegistrationNo(e.currentTarget.value)} />
          <Field label="Credential expiry" optional type="date" hint="When the credential lapses" data-testid="ops-staff-expiry" value={credentialExpiry} onChange={(e) => setCredentialExpiry(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="ops-staff-submit" disabled={adding}
            {...(fullName.trim() === '' ? { disabledReason: 'Enter the full name' } : role.trim() === '' ? { disabledReason: 'Enter the role' } : {})}
            onClick={addStaff}>Add staff</Button>
        </div>
        {addMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={addMsg.tone} assertive={addMsg.tone === 'danger'}>{addMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
