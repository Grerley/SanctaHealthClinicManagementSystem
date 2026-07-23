import { useState } from 'react';
import { Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import './screens.css';

type SelfSummary = {
  patient: { mrn: string | null; name: string };
  accountBalanceMinor: number;
  upcomingAppointments: Array<{ startsAt: string; provider: string; status: string }>;
  documentCount: number;
};

/**
 * Read-only portal summary for a patient (COM-006) — the same balance, upcoming
 * appointments and document count a patient sees online, resolved from their access
 * token so staff can help over the phone. There is no token on mount, so the load is
 * token-triggered: before a lookup the area shows an empty prompt; a rejected or
 * unreachable lookup surfaces as a stale state (§6.6). The token is sensitive — it is
 * entered masked, never rendered, never logged, and never placed in a test id.
 */
export function SelfServiceSummary() {
  const [token, setToken] = useState('');
  const [summary, setSummary] = useState<SelfSummary | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const load = async () => {
    if (token.trim() === '') return;
    setState('loading');
    try {
      const r = await jsonFetch<SelfSummary>(`/api/selfservice/summary?token=${encodeURIComponent(token.trim())}`);
      setSummary(r); setState('ready');
    } catch { setSummary(null); setState('error'); }
  };

  return (
    <section className="scr" aria-label="Self-service portal summary">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Portal summary (COM-006)</h3>
            <Field label="Access token" type="password" hint="The patient's portal access token" data-testid="ss-summary-token" value={token} onChange={(e) => setToken(e.currentTarget.value)} />
            <Button variant="primary" icon={<Icon name="sync" />} data-testid="ss-summary-load" disabled={state === 'loading'}
              {...(token.trim() === '' ? { disabledReason: 'Enter the patient access token' } : {})}
              onClick={() => void load()}>Look up</Button>
          </div>
          {state === 'ready' && summary && (
            <StatusTag tone={summary.accountBalanceMinor > 0 ? 'warning' : 'success'} icon={summary.accountBalanceMinor > 0 ? 'alert' : 'check'}>
              {summary.accountBalanceMinor > 0 ? `Balance ${money(summary.accountBalanceMinor)}` : 'Settled'}
            </StatusTag>
          )}
        </div>
        {state === 'idle' && <StateBlock state="empty" title="No summary loaded">Enter a patient access token and look up to view their portal balance and upcoming appointments.</StateBlock>}
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading summary" />}
        {state === 'error' && <StateBlock state="stale" title="Summary unavailable">The token may be invalid, revoked or expired, or the clinic hub may be unreachable. Nothing was changed.</StateBlock>}
        {state === 'ready' && summary && (
          <>
            <div className="scr__kpi-grid" data-testid="ss-summary-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
              <div className="scr__kpi">
                <span className="scr__kpi-label">Patient</span>
                <span className="scr__kpi-value">{summary.patient.name || '—'}</span>
                <span className="scr__kpi-meta">{summary.patient.mrn ? `MRN ${summary.patient.mrn}` : 'No MRN on file'}</span>
              </div>
              <div className="scr__kpi">
                <span className="scr__kpi-label">Account balance</span>
                <span className="scr__kpi-value" style={{ color: summary.accountBalanceMinor > 0 ? 'var(--sancta-colour-warning)' : undefined }}>{money(summary.accountBalanceMinor)}</span>
                <span className="scr__kpi-meta">Outstanding across finalised invoices</span>
              </div>
              <div className="scr__kpi">
                <span className="scr__kpi-label">Documents</span>
                <span className="scr__kpi-value">{summary.documentCount}</span>
                <span className="scr__kpi-meta">On the patient record</span>
              </div>
              <div className="scr__kpi">
                <span className="scr__kpi-label">Upcoming appointments</span>
                <span className="scr__kpi-value">{summary.upcomingAppointments.length}</span>
                <span className="scr__kpi-meta">Booked, accepted or in progress</span>
              </div>
            </div>
            <div style={{ marginTop: 'var(--sancta-space-4)' }}>
              <h3 className="scr__section-title">Upcoming appointments</h3>
              {summary.upcomingAppointments.length === 0
                ? <StateBlock state="empty" title="No upcoming appointments">This patient has no booked, accepted or in-progress appointments.</StateBlock>
                : (
                  <div className="scr__table-scroll">
                    <table className="scr__table" data-testid="ss-summary-appts">
                      <caption className="sancta-visually-hidden">Upcoming appointments visible to the patient in the online portal</caption>
                      <thead><tr><th scope="col">Starts at</th><th scope="col">Provider</th><th scope="col">Status</th></tr></thead>
                      <tbody>
                        {summary.upcomingAppointments.map((a, i) => (
                          <tr key={`${a.startsAt}-${i}`}>
                            <td data-numeric>{a.startsAt}</td>
                            <td>{a.provider}</td>
                            <td><StatusTag tone="info" icon="info">{a.status}</StatusTag></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
