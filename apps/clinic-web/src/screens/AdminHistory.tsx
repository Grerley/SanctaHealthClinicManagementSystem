import { useState } from 'react';
import { Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type AdministrationRow = { id: string; administeredAt: string; dose: string | null; route: string | null; site: string | null; status: string; reason: string | null };

/**
 * Medication administration history (MED-006). Read-only: the administration trail for a
 * medication request — each dose given (or withheld, with a reason) with time, route and
 * site, so a clinician can see exactly what was administered.
 */
export function AdminHistory() {
  const [requestId, setRequestId] = useState('');
  const [rows, setRows] = useState<AdministrationRow[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const load = async () => {
    if (requestId.trim() === '') return;
    setState('loading');
    try { const r = await jsonFetch<{ administrations: AdministrationRow[] }>(`/api/prescribe/administrations?requestId=${encodeURIComponent(requestId.trim())}`); setRows(r.administrations); setState('ready'); }
    catch { setState('error'); }
  };

  const tone = (s: string): 'success' | 'warning' | 'neutral' => (s === 'given' ? 'success' : s === 'withheld' ? 'warning' : 'neutral');

  return (
    <section className="scr" aria-label="Administration history">
      <div>
        <div className="scr__toolbar">
          <h3 className="scr__section-title">Administration history</h3>
          <Field label="Request id" hint="The medication request" data-testid="admin-history-request" value={requestId} onChange={(e) => setRequestId(e.currentTarget.value)} />
          <Button variant="primary" icon={<Icon name="sync" />} data-testid="admin-history-go" disabled={state === 'loading'}
            {...(requestId.trim() === '' ? { disabledReason: 'Enter a request id' } : {})} onClick={load}>Load</Button>
        </div>
        {state === 'idle' && <StateBlock state="empty" title="Enter a request">Enter a medication request id to see its administrations.</StateBlock>}
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading" />}
        {state === 'error' && <StateBlock state="stale" title="History unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          rows.length === 0
            ? <StateBlock state="empty" title="No administrations">No administrations recorded for this request.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="admin-history">
                  <caption className="sancta-visually-hidden">Administrations recorded against the medication request</caption>
                  <thead><tr><th scope="col">When</th><th scope="col">Dose</th><th scope="col">Route</th><th scope="col">Site</th><th scope="col">Status</th><th scope="col">Reason</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td data-numeric>{new Date(r.administeredAt).toLocaleString()}</td>
                        <td>{r.dose ?? '—'}</td>
                        <td>{r.route ?? '—'}</td>
                        <td>{r.site ?? '—'}</td>
                        <td><StatusTag tone={tone(r.status)}>{r.status}</StatusTag></td>
                        <td>{r.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
    </section>
  );
}
