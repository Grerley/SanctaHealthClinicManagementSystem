import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Referral = { id: string; patientId: string; targetFacility: string; status: string };

/**
 * Referral status (REF-003). The open referrals queue plus an explicit status
 * transition (with optional feedback) so an outbound referral is tracked to its close.
 * The transition is a confirmed-commit write (§9.2); the queue reloads after each.
 */
export function ReferralStatus() {
  const [rows, setRows] = useState<Referral[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [referralId, setReferralId] = useState('');
  const [to, setTo] = useState('');
  const [feedback, setFeedback] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try { const r = await jsonFetch<{ referrals: Referral[] }>('/api/referrals/open'); setRows(r.referrals); setState('ready'); }
    catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const ready = referralId.trim() !== '' && to.trim() !== '';

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ status: string }>(
      '/api/referrals/status',
      { referralId: referralId.trim(), to: to.trim(), ...(feedback.trim() ? { feedback: feedback.trim() } : {}) },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Referral ···${referralId.trim().slice(-8)} → ${to.trim()}.` });
      setReferralId(''); setTo(''); setFeedback(''); setIdem(newIdempotencyKey());
      try { await load(); } catch { /* covered */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not update the referral (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Referral status">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Open referrals</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="referral-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          <StatusTag tone={rows.length > 0 ? 'warning' : 'success'} icon={rows.length > 0 ? 'alert' : 'check'}>{rows.length > 0 ? `${rows.length} open` : 'None open'}</StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading referrals" />}
        {state === 'error' && <StateBlock state="stale" title="Referrals unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          rows.length === 0
            ? <StateBlock state="empty" title="No open referrals">Every referral has been closed out.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="referral-open">
                  <caption className="sancta-visually-hidden">Open outbound referrals</caption>
                  <thead><tr><th scope="col">Referral</th><th scope="col">Patient</th><th scope="col">Target</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} data-selected={referralId === r.id || undefined}>
                        <td data-numeric>···{r.id.slice(-8)}</td>
                        <td data-numeric>···{r.patientId.slice(-8)}</td>
                        <td>{r.targetFacility}</td>
                        <td><StatusTag tone="info">{r.status}</StatusTag></td>
                        <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`referral-pick-${r.id.slice(-8)}`} onClick={() => { setReferralId(r.id); setMsg(null); }}>Update</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="referral-status-form">
        <h3 className="scr__section-title">Update status</h3>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Referral id" hint="Pick from the list or paste" data-testid="referral-id" value={referralId} onChange={(e) => setReferralId(e.currentTarget.value)} />
          <Field label="New status" hint="e.g. accepted, completed, declined" data-testid="referral-to" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
          <Field label="Feedback" optional hint="Notes from the target service" data-testid="referral-feedback" value={feedback} onChange={(e) => setFeedback(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="referral-submit" disabled={busy}
            {...(referralId.trim() === '' ? { disabledReason: 'Choose a referral' } : to.trim() === '' ? { disabledReason: 'Enter the new status' } : {})}
            onClick={submit}>Update referral</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
