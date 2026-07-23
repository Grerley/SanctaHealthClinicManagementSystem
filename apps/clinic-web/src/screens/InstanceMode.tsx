import { useEffect, useState } from 'react';
import { Banner, Button, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type InstanceInfo = {
  mode: 'production' | 'training' | 'test';
  nonProduction: boolean;
  banner: string;
  syntheticDataOnly: boolean;
};

const MODE_TONE: Record<string, 'success' | 'warning' | 'info'> = { production: 'success', training: 'warning', test: 'info' };

/**
 * Instance environment identity (ADM-007). Surfaces which instance the operator is
 * working in — production, training or test — so no one mistakes a training system
 * for the real record. Anything not explicitly "production" is treated and MARKED
 * as non-production (fail-safe), and non-production instances are stated to hold
 * synthetic data only. This is a read-only surface: the mode is fixed by the
 * instance's configuration, not switchable from the client. Reads /api/instance on
 * open — a no-parameter read present on both the edge and the Worker.
 */
export function InstanceMode() {
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = async () => {
    setState('loading');
    try { setInfo(await jsonFetch<InstanceInfo>('/api/instance')); setState('ready'); }
    catch { setState('error'); }
  };

  useEffect(() => { void load(); }, []);

  if (state === 'loading') return <StateBlock state="initial-loading" title="Identifying this instance" />;
  if (state === 'error' || !info) return <StateBlock state="stale" title="Instance identity unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Instance environment identity">
      {info.nonProduction && (
        <Banner tone="warning" assertive title="Non-production instance">{info.banner}</Banner>
      )}

      <div className="scr__card" data-testid="inst-card">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Environment (ADM-07)</h3>
          <Button variant="subtle" density="compact" data-testid="inst-refresh" icon={<Icon name="sync" />} onClick={() => void load()}>Re-check</Button>
        </div>

        <div className="scr__kpi-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <div className="scr__kpi" data-testid="inst-mode">
            <span className="scr__kpi-label">Mode</span>
            <span className="scr__kpi-value" style={{ display: 'flex', alignItems: 'center' }}>
              <StatusTag tone={MODE_TONE[info.mode] ?? 'info'} icon={info.mode === 'production' ? 'check' : 'alert'}>{info.mode}</StatusTag>
            </span>
          </div>
          <div className="scr__kpi">
            <span className="scr__kpi-label">Classification</span>
            <span className="scr__kpi-value" style={{ display: 'flex', alignItems: 'center' }}>
              <StatusTag tone={info.nonProduction ? 'warning' : 'success'} icon={info.nonProduction ? 'alert' : 'check'}>
                {info.nonProduction ? 'Non-production' : 'Production'}
              </StatusTag>
            </span>
          </div>
          <div className="scr__kpi">
            <span className="scr__kpi-label">Data policy</span>
            <span className="scr__kpi-value" style={{ display: 'flex', alignItems: 'center' }}>
              <StatusTag tone={info.syntheticDataOnly ? 'warning' : 'neutral'} icon={info.syntheticDataOnly ? 'lock' : null}>
                {info.syntheticDataOnly ? 'Synthetic data only' : 'Live clinical record'}
              </StatusTag>
            </span>
          </div>
        </div>

        <p className="scr__kpi-meta" style={{ marginTop: 'var(--sancta-space-3)' }}>
          The instance mode is set by this deployment's configuration and cannot be changed from a client screen.
          Non-production instances are marked so a training or test system is never mistaken for the live record, and
          must never hold real patient data.
        </p>
      </div>
    </section>
  );
}
