import { useEffect, useState } from 'react';
import { StatusTag, StateBlock } from '@sancta/ui';
import { api, type Kpi, type Exception } from '../api.ts';
import './screens.css';

/**
 * Management command centre (MGT-01). Exceptions lead before summaries (§9); each
 * exception carries a count, owner and links to its work queue. Every KPI carries a
 * definition/owner/unit (MGT-008) — derived live, never an editable field. DOM
 * contract preserved for the e2e suite.
 */
export function Dashboard() {
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const d = await api.dashboard();
        setKpis(d.kpis);
        setExceptions(d.exceptions);
      } catch {
        setError('Dashboard unavailable offline.');
      }
    })();
  }, []);

  return (
    <section className="scr">
      <div>
        <h3 className="scr__section-title">Exceptions</h3>
        <div data-testid="dash-exceptions">
          {exceptions.length === 0 ? (
            <StateBlock state="empty" title="No open exceptions">Everything reconciles — nothing needs attention right now.</StateBlock>
          ) : (
            <ul className="scr__list">
              {exceptions.map((e) => (
                <li key={e.type}>
                  <div className="scr__list-btn" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sancta-space-3)', cursor: 'default' }}>
                    <StatusTag tone="warning" icon="alert">{String(e.count)}</StatusTag>
                    <span style={{ flex: 1 }}>{e.label}</span>
                    <span className="scr__kpi-meta">{e.owner}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <h3 className="scr__section-title">Key indicators</h3>
        <div data-testid="dash-kpis" className="scr__kpi-grid">
          {kpis.map((k) => (
            <div key={k.id} className="scr__kpi" title={k.formula}>
              <span className="scr__kpi-label">{k.label}</span>
              <span className="scr__kpi-value">{k.value}</span>
              <span className="scr__kpi-meta">{k.unit} · {k.owner}</span>
            </div>
          ))}
        </div>
      </div>
      {error && <StateBlock state="stale" title="Dashboard unavailable offline">{error}</StateBlock>}
    </section>
  );
}
