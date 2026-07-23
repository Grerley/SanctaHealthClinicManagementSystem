import { useCallback, useEffect, useState } from 'react';
import { Button, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type Capacity = { kind: string; availableUnits: number; availableCapacity: number };

const KINDS = [
  { kind: 'room', label: 'Rooms' },
  { kind: 'service_point', label: 'Service points' },
  { kind: 'equipment', label: 'Equipment' },
] as const;

/**
 * Facility capacity & occupancy board (OPS-002). A read-only view of available units
 * and total available capacity for each resource kind — rooms, service points and
 * equipment. Each kind is queried independently; the board reloads on demand.
 */
export function FacilityCapacity() {
  const [rows, setRows] = useState<Capacity[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const results = await Promise.all(
        KINDS.map((k) => jsonFetch<Capacity>(`/api/facility/capacity?kind=${encodeURIComponent(k.kind)}`)),
      );
      setRows(results); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const labelFor = (kind: string) => KINDS.find((k) => k.kind === kind)?.label ?? kind;
  const totalUnits = rows.reduce((n, r) => n + r.availableUnits, 0);

  return (
    <section className="scr" aria-label="Facility capacity and occupancy" data-testid="facility-capacity">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Available capacity (OPS-002)</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="fac-cap-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          {state === 'ready' && (
            <StatusTag tone={totalUnits > 0 ? 'success' : 'warning'} icon={totalUnits > 0 ? 'check' : 'alert'}>
              {`${totalUnits} unit${totalUnits === 1 ? '' : 's'} free`}
            </StatusTag>
          )}
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading capacity" />}
        {state === 'error' && <StateBlock state="stale" title="Capacity unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          rows.length === 0
            ? <StateBlock state="empty" title="No capacity data">No resource kinds returned capacity.</StateBlock>
            : (
              <div data-testid="fac-cap-kpis" className="scr__kpi-grid">
                {rows.map((r) => (
                  <div key={r.kind} className="scr__kpi">
                    <span className="scr__kpi-label">{labelFor(r.kind)}</span>
                    <span className="scr__kpi-value">{r.availableUnits}</span>
                    <span className="scr__kpi-meta">{`available now · ${r.availableCapacity} capacity`}</span>
                  </div>
                ))}
              </div>
            )
        )}
      </div>

      {state === 'ready' && rows.length > 0 && (
        <div className="scr__card" data-testid="fac-cap-table-card">
          <h3 className="scr__section-title">By resource kind</h3>
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="fac-cap-table">
              <caption className="sancta-visually-hidden">Available units and total capacity for each facility resource kind</caption>
              <thead><tr><th scope="col">Kind</th><th scope="col">Available units</th><th scope="col">Available capacity</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.kind}>
                    <td>{labelFor(r.kind)}</td>
                    <td data-numeric>{r.availableUnits}</td>
                    <td data-numeric>{r.availableCapacity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
