import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type Patient, type OpenReferral } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const SENT_BY = 'demo-operator';
const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = { sent: 'info', acknowledged: 'warning', in_progress: 'warning', completed: 'success', closed: 'neutral' };

/**
 * Outbound referrals (ORD-08). Refer the patient in context to another facility with
 * a documented reason, and track referrals that are still open until they are closed
 * — so a referral is never lost in transit. Creating a referral is a confirmed-commit
 * write (§9.2) with the draft preserved on failure. The open-referrals list is a
 * no-parameter read (present on both backends), so it carries no edge-schema risk.
 */
export function Referrals({ patient }: { patient: Patient | null }) {
  const [open, setOpen] = useState<OpenReferral[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [facility, setFacility] = useState('');
  const [reason, setReason] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => { const r = await api.openReferrals(); setOpen(r.referrals); }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const canSubmit = patient !== null && facility.trim().length > 0;

  const submit = async () => {
    if (!patient || !canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/referrals',
      { patientId: patient.id, targetFacility: facility.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}), sentBy: SENT_BY },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `Referral to ${facility.trim()} sent and saved. Reference ···${res.data.id.slice(-8)}.` });
      setFacility(''); setReason(''); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was sent — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not send the referral (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading referrals" />;
  if (state === 'error') return <StateBlock state="stale" title="Referrals unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Referrals">
      <div className="scr__card" data-testid="ref-form">
        <h3 className="scr__section-title">Refer patient (ORD-08)</h3>
        {patient
          ? <p className="scr__kpi-meta">Referring {patient.given_name} {patient.family_name} to an external facility.</p>
          : <Banner tone="warning" title="No patient in context">Choose a patient from Patients to create a referral.</Banner>}
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Target facility" hint="Where the patient is being referred" data-testid="ref-facility" value={facility} onChange={(e) => setFacility(e.currentTarget.value)} />
          <Field label="Reason" optional hint="Clinical reason for the referral" data-testid="ref-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="ref-submit" disabled={busy}
            {...(!patient ? { disabledReason: 'Select a patient first' } : facility.trim() === '' ? { disabledReason: 'Enter a target facility' } : {})}
            onClick={submit}>Send referral</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Open referrals</h3>
          <StatusTag tone={open.length > 0 ? 'neutral' : 'success'} icon={open.length > 0 ? null : 'check'}>
            {open.length > 0 ? `${open.length} in progress` : 'None open'}
          </StatusTag>
        </div>
        {open.length === 0
          ? <StateBlock state="empty" title="No open referrals">Every referral has been closed.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="ref-open">
                <caption className="sancta-visually-hidden">Referrals that are still open, awaiting the receiving facility</caption>
                <thead><tr><th scope="col">Reference</th><th scope="col">Facility</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {open.map((r) => (
                    <tr key={r.id}>
                      <td data-numeric>···{r.id.slice(-8)}</td>
                      <td>{r.targetFacility}</td>
                      <td><StatusTag tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</StatusTag></td>
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
