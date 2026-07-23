import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type StaffProductivity = {
  staffId: string;
  actions: Record<string, number>;
  total: number;
  highAcuityTriage: number;
};

function monthStart(): string { return new Date().toISOString().slice(0, 7) + '-01'; }
function nextMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/**
 * Staff activity/productivity over a period with complexity context (OPS-007). A
 * read-only board scoped by a from/to DATE window — figures are counted from the
 * audit trail (every attributable action is audited), so they reconcile to what
 * actually happened; the high-acuity triage count is complexity context, never a
 * stand-alone performance verdict. Staff ids are masked; no identifiers are logged.
 */
export function OpsProductivity() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(nextMonthStart());
  const [rows, setRows] = useState<StaffProductivity[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async (f: string, t: string) => {
    setState('loading');
    try {
      const r = await jsonFetch<{ productivity?: StaffProductivity[]; staff?: StaffProductivity[] }>(
        `/api/ops/productivity?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`,
      );
      setRows(r.productivity ?? r.staff ?? []); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(from, to); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="scr" aria-label="Staff productivity">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Productivity (OPS-007)</h3>
            <Field label="From" type="date" hint="Period start (inclusive)" data-testid="ops-prod-from" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
            <Field label="To" type="date" hint="Period end (exclusive)" data-testid="ops-prod-to" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="ops-prod-refresh" disabled={state === 'loading'} onClick={() => void load(from, to)}>Refresh</Button>
          </div>
          <StatusTag tone="info" icon="info">{`${rows.length} staff`}</StatusTag>
        </div>
        <p className="scr__kpi-meta">Activity is context, never a stand-alone performance verdict. High-acuity triage is a complexity signal, not a ranking.</p>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading productivity" />}
        {state === 'error' && <StateBlock state="stale" title="Productivity unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          rows.length === 0
            ? <StateBlock state="empty" title="No activity">No attributable activity was recorded in this period.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="ops-prod-table">
                  <caption className="sancta-visually-hidden">Staff activity totals and high-acuity triage over the selected period, ordered by total activity</caption>
                  <thead><tr><th scope="col">Staff</th><th scope="col">Total actions</th><th scope="col">Action types</th><th scope="col">High-acuity triage</th></tr></thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.staffId}>
                        <td>{`···${s.staffId.slice(-8)}`}</td>
                        <td data-numeric>{s.total}</td>
                        <td data-numeric>{Object.keys(s.actions).length}</td>
                        <td data-numeric>
                          {s.highAcuityTriage > 0
                            ? <StatusTag tone="warning" icon="alert">{`${s.highAcuityTriage} high-acuity`}</StatusTag>
                            : <StatusTag tone="neutral" icon={null}>{'0'}</StatusTag>}
                        </td>
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
