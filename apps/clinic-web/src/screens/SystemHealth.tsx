import { useEffect, useState } from 'react';
import { Banner, Button, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type SystemHealth = {
  database: 'ok' | 'unreachable';
  pendingSync: number;
  integrationQueue: { queued: number; dead: number };
  openConflicts: number;
  status: 'ok' | 'attention';
  checkedAt: string;
};

const n = (v: number) => (v < 0 ? '—' : String(v));

/**
 * Platform health monitor (ADM-005). Aggregates the operational signals a clinic
 * administrator watches: database reachability, the outbound sync backlog, the
 * integration queue (queued and dead-letter counts) and open sync conflicts. An
 * overall "attention" status is raised when anything needs a human — dead letters
 * or open conflicts. Read-only and no-parameter (present on both the edge and the
 * Worker); a manual re-check re-reads on demand. No patient data is surfaced —
 * these are counts and health flags only.
 */
export function SystemHealth() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);

  const load = async (manual = false) => {
    if (manual) setBusy(true); else setState('loading');
    try { setHealth(await jsonFetch<SystemHealth>('/api/admin/health')); setState('ready'); }
    catch { setState('error'); }
    finally { setBusy(false); }
  };

  useEffect(() => { void load(); }, []);

  if (state === 'loading') return <StateBlock state="initial-loading" title="Checking platform health" />;
  if (state === 'error' || !health) return <StateBlock state="stale" title="Health report unavailable">The clinic hub may be unreachable.</StateBlock>;

  const attention = health.status === 'attention';

  return (
    <section className="scr" aria-label="Platform health">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">System health (ADM-05)</h3>
        <div className="scr__row" style={{ alignItems: 'center' }}>
          <StatusTag tone={attention ? 'warning' : 'success'} icon={attention ? 'alert' : 'check'}>
            {attention ? 'Needs attention' : 'All clear'}
          </StatusTag>
          <Button variant="subtle" density="compact" data-testid="health-refresh" disabled={busy} icon={<Icon name="sync" />} onClick={() => void load(true)}>Re-check</Button>
        </div>
      </div>

      <div className="scr__kpi-grid" data-testid="health-grid">
        <div className="scr__kpi">
          <span className="scr__kpi-label">Database</span>
          <span className="scr__kpi-value" style={{ display: 'flex', alignItems: 'center' }}>
            <StatusTag tone={health.database === 'ok' ? 'success' : 'danger'} icon={health.database === 'ok' ? 'check' : 'alert'}>{health.database}</StatusTag>
          </span>
        </div>
        <div className="scr__kpi">
          <span className="scr__kpi-label">Pending sync (outbox)</span>
          <span className="scr__kpi-value">{n(health.pendingSync)}</span>
        </div>
        <div className="scr__kpi">
          <span className="scr__kpi-label">Integration queued</span>
          <span className="scr__kpi-value">{n(health.integrationQueue.queued)}</span>
        </div>
        <div className="scr__kpi" data-testid="health-dead">
          <span className="scr__kpi-label">Integration dead-letters</span>
          <span className="scr__kpi-value" style={{ color: health.integrationQueue.dead > 0 ? 'var(--sancta-colour-danger)' : undefined }}>{n(health.integrationQueue.dead)}</span>
        </div>
        <div className="scr__kpi">
          <span className="scr__kpi-label">Open conflicts</span>
          <span className="scr__kpi-value" style={{ color: health.openConflicts > 0 ? 'var(--sancta-colour-warning)' : undefined }}>{n(health.openConflicts)}</span>
        </div>
      </div>

      {health.database === 'unreachable' && (
        <Banner tone="danger" assertive title="Database unreachable">Health counts could not be read; the figures above show a dash until the hub responds.</Banner>
      )}
      {attention && health.database === 'ok' && (
        <Banner tone="warning" title="Follow-up needed">
          {`${health.integrationQueue.dead} dead-letter${health.integrationQueue.dead === 1 ? '' : 's'} and ${health.openConflicts} open conflict${health.openConflicts === 1 ? '' : 's'} need a person to review them.`}
        </Banner>
      )}

      <p className="scr__kpi-meta">{`Checked ${health.checkedAt.replace('T', ' ').slice(0, 19)} UTC.`}</p>
    </section>
  );
}
