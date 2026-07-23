import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const mask = (v: string): string => `···${v.slice(-8)}`;

type Issued = { tail: string; expiresAt: string; full: string };

/**
 * Portal access tokens (COM-006). Staff issue a scoped, time-boxed token that lets a
 * patient authenticate to the online portal — separate from staff RBAC — and revoke
 * it on logout or suspected compromise. Both are confirmed-commit writes (§9.2) with
 * the draft preserved on failure.
 *
 * SENSITIVE: a token is a bearer credential. The full value is kept only in local
 * component state so it can be handed over or revoked in one click; it is NEVER
 * rendered in full, NEVER logged, and NEVER placed in a test id or aria-label — only
 * a masked tail is displayed.
 */
export function SelfServiceTokens() {
  const [patientId, setPatientId] = useState('');
  const [ttlHours, setTtlHours] = useState('');
  const [issueIdem, setIssueIdem] = useState(newIdempotencyKey());
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [issueMsg, setIssueMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [revokeValue, setRevokeValue] = useState('');
  const [revokeIdem, setRevokeIdem] = useState(newIdempotencyKey());
  const [revoking, setRevoking] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const issue = async () => {
    if (patientId.trim() === '') return;
    setIssuing(true); setIssueMsg(null);
    const ttl = Number(ttlHours);
    const res = await mutate<{ token: string; expiresAt: string }>(
      '/api/selfservice/token',
      {
        patientId: patientId.trim(),
        ...(ttlHours.trim() && Number.isFinite(ttl) && ttl > 0 ? { ttlHours: Math.round(ttl) } : {}),
      },
      { idempotencyKey: issueIdem },
    );
    setIssuing(false);
    if (res.ok && res.data?.token) {
      const tok = res.data.token;
      setIssued({ tail: mask(tok), expiresAt: res.data.expiresAt, full: tok });
      setIssueMsg({ tone: 'success', text: `Token issued for patient ${mask(patientId.trim())}. Hand it to the patient securely — it is shown masked here.` });
      setPatientId(''); setTtlHours(''); setIssueIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setIssueMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setIssueMsg({ tone: 'danger', text: `Could not issue a token (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const doRevoke = async (value: string, fromIssued: boolean) => {
    if (value.trim() === '') return;
    setRevoking(true); setRevokeMsg(null);
    const res = await mutate<{ ok: boolean }>(
      '/api/selfservice/token/revoke',
      { token: value.trim() },
      { idempotencyKey: revokeIdem },
    );
    setRevoking(false);
    if (res.ok) {
      setRevokeMsg({ tone: 'success', text: `Token ${mask(value.trim())} revoked. It can no longer access the portal.` });
      setRevokeIdem(newIdempotencyKey());
      if (fromIssued) setIssued(null); else setRevokeValue('');
    } else if (res.errorCode === 'network') {
      setRevokeMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setRevokeMsg({ tone: 'danger', text: `Could not revoke the token (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Portal access tokens">
      <div className="scr__card" data-testid="ss-token-issue-form">
        <h3 className="scr__section-title">Issue an access token (COM-006)</h3>
        <p className="scr__kpi-meta">Creates a time-boxed token that authenticates one patient to the online portal. Treat it as a password: it is displayed masked and never logged. Default validity is 24 hours.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Patient id" hint="The patient this token authenticates" data-testid="ss-token-patient" value={patientId} onChange={(e) => setPatientId(e.currentTarget.value)} />
          <Field label="Validity (hours)" optional numeric hint="How long the token stays valid" data-testid="ss-token-ttl" value={ttlHours} onChange={(e) => setTtlHours(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="lock" />} data-testid="ss-token-issue-submit" disabled={issuing}
            {...(patientId.trim() === '' ? { disabledReason: 'Enter the patient id' } : {})}
            onClick={issue}>Issue token</Button>
        </div>
        {issued && (
          <div className="scr__row" style={{ alignItems: 'center', gap: 'var(--sancta-space-3)', marginTop: 'var(--sancta-space-3)' }} data-testid="ss-token-issued">
            <StatusTag tone="info" icon="lock">{`Token ${issued.tail}`}</StatusTag>
            <span className="scr__kpi-meta">{`Expires ${issued.expiresAt}`}</span>
            <Button variant="secondary" tone="danger" density="compact" data-testid="ss-token-issued-revoke" disabled={revoking} onClick={() => void doRevoke(issued.full, true)}>Revoke this token</Button>
          </div>
        )}
        {issueMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={issueMsg.tone} assertive={issueMsg.tone === 'danger'}>{issueMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="ss-token-revoke-form">
        <h3 className="scr__section-title">Revoke a token</h3>
        <p className="scr__kpi-meta">Paste a token to revoke it — for a lost device or suspected compromise. Revocation is immediate. The value is masked in confirmations and never logged.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Token" type="password" hint="The portal token to revoke" data-testid="ss-token-revoke-value" value={revokeValue} onChange={(e) => setRevokeValue(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone="danger" icon={<Icon name="lock" />} data-testid="ss-token-revoke-submit" disabled={revoking}
            {...(revokeValue.trim() === '' ? { disabledReason: 'Paste the token to revoke' } : {})}
            onClick={() => void doRevoke(revokeValue, false)}>Revoke token</Button>
        </div>
        {revokeMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={revokeMsg.tone} assertive={revokeMsg.tone === 'danger'}>{revokeMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
