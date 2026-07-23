import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type ConfigResult = { config?: { version: number; payload: unknown } | null; version?: number; payload?: unknown };

const csv = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Feature configuration & published config (ADM-006/003). Two operational tools for
 * a platform administrator, both scoped to safe, user-action-driven reads (no
 * mount-time uuid lookup):
 *  - Evaluate a feature flag for the current context (GET /api/admin/feature-flag).
 *  - Set / stage a feature flag by site and role (POST) — a CONFIG CHANGE, so it is
 *    a confirmed-commit control event: it is confirmed explicitly and the draft is
 *    preserved on failure.
 *  - Look up the currently PUBLISHED config release by name (GET /api/admin/config).
 * No patient data is involved. All three endpoints exist on both the edge and the
 * Worker; response bodies are read defensively across the two.
 */
export function AdminSettings() {
  // --- flag evaluation ---
  const [evalKey, setEvalKey] = useState('');
  const [evalResult, setEvalResult] = useState<boolean | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);

  // --- flag set (control event) ---
  const [setKey, setSetKey] = useState('');
  const [setEnabled, setSetEnabled] = useState(true);
  const [sites, setSites] = useState('');
  const [roles, setRoles] = useState('');
  const [confirmSet, setConfirmSet] = useState(false);
  const [setBusy, setSetBusy] = useState(false);
  const [setMsg, setSetMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // --- config lookup ---
  const [cfgName, setCfgName] = useState('');
  const [cfg, setCfg] = useState<{ version: number; payload: unknown } | null | 'none'>(null);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [cfgErr, setCfgErr] = useState<string | null>(null);

  const evaluate = async () => {
    if (!evalKey.trim()) return;
    setEvalBusy(true); setEvalResult(null);
    try {
      const r = await jsonFetch<{ enabled: boolean }>(`/api/admin/feature-flag?key=${encodeURIComponent(evalKey.trim())}`);
      setEvalResult(Boolean(r.enabled));
    } catch { setEvalResult(null); }
    finally { setEvalBusy(false); }
  };

  const applyFlag = async () => {
    setSetBusy(true); setSetMsg(null);
    const res = await mutate<{ key: string }>(
      '/api/admin/feature-flag',
      { key: setKey.trim(), enabled: setEnabled, sites: csv(sites), roles: csv(roles) },
      { idempotencyKey: newIdempotencyKey() },
    );
    setSetBusy(false); setConfirmSet(false);
    if (res.ok) {
      setSetMsg({ tone: 'success', text: `Flag "${setKey.trim()}" ${setEnabled ? 'enabled' : 'disabled'}${csv(sites).length || csv(roles).length ? ' for the selected scope' : ' everywhere'}.` });
    } else if (res.errorCode === 'network') {
      setSetMsg({ tone: 'danger', text: 'Could not reach the clinic hub — the flag was NOT changed. Retry when connected.' });
    } else {
      setSetMsg({ tone: 'danger', text: `Could not update the flag (${res.errorCode ?? 'error'}).` });
    }
  };

  const lookup = async () => {
    if (!cfgName.trim()) return;
    setCfgBusy(true); setCfg(null); setCfgErr(null);
    try {
      const r = await jsonFetch<ConfigResult>(`/api/admin/config?name=${encodeURIComponent(cfgName.trim())}`);
      const found = r.config !== undefined ? r.config : (r.version !== undefined ? { version: r.version, payload: r.payload } : null);
      setCfg(found && found.version > 0 ? found : 'none');
    } catch { setCfgErr('Could not read the config release.'); }
    finally { setCfgBusy(false); }
  };

  return (
    <section className="scr" aria-label="Feature configuration and published config">
      <div className="scr__card" data-testid="flag-eval">
        <h3 className="scr__section-title">Evaluate a feature flag (ADM-06)</h3>
        <p className="scr__kpi-meta">Check whether a flag resolves ON for your current site and roles. An unknown flag resolves OFF.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Flag key" hint="e.g. new-triage-flow" data-testid="flag-eval-key" value={evalKey} onChange={(e) => setEvalKey(e.currentTarget.value)} style={{ minWidth: 240 }} />
          <Button variant="primary" data-testid="flag-eval-btn" disabled={evalBusy} {...(!evalKey.trim() ? { disabledReason: 'Enter a flag key' } : {})} icon={<Icon name="info" />} onClick={evaluate}>Evaluate</Button>
          {evalResult !== null && (
            <StatusTag tone={evalResult ? 'success' : 'neutral'} icon={evalResult ? 'check' : null}>{evalResult ? 'ON for you' : 'OFF for you'}</StatusTag>
          )}
        </div>
      </div>

      <div className="scr__card" data-testid="flag-set">
        <h3 className="scr__section-title">Stage a feature flag</h3>
        <p className="scr__kpi-meta">Turn a flag on or off, optionally limited to a set of sites and/or roles for a staged rollout. Changing a flag is a configuration change.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Flag key" data-testid="flag-set-key" value={setKey} onChange={(e) => setSetKey(e.currentTarget.value)} style={{ minWidth: 220 }} />
          <div className="scr__seg" role="group" aria-label="Flag state">
            <button type="button" className="scr__seg-btn sancta-focusable" data-testid="flag-set-on" data-active={setEnabled} aria-pressed={setEnabled} onClick={() => setSetEnabled(true)}>Enabled</button>
            <button type="button" className="scr__seg-btn sancta-focusable" data-testid="flag-set-off" data-active={!setEnabled} aria-pressed={!setEnabled} onClick={() => setSetEnabled(false)}>Disabled</button>
          </div>
          <Field label="Sites" optional hint="comma-separated ids; blank = all" data-testid="flag-set-sites" value={sites} onChange={(e) => setSites(e.currentTarget.value)} />
          <Field label="Roles" optional hint="comma-separated; blank = all" data-testid="flag-set-roles" value={roles} onChange={(e) => setRoles(e.currentTarget.value)} />
          <Button variant="primary" data-testid="flag-set-btn" disabled={setBusy} {...(!setKey.trim() ? { disabledReason: 'Enter a flag key' } : {})} onClick={() => setConfirmSet(true)}>Review change</Button>
        </div>

        {confirmSet && (
          <div className="scr__card" data-testid="flag-set-confirm" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Banner tone="warning" title={`${setEnabled ? 'Enable' : 'Disable'} "${setKey.trim()}"?`} assertive>
              {`This changes platform configuration for ${csv(sites).length ? `sites ${csv(sites).join(', ')}` : 'all sites'} and ${csv(roles).length ? `roles ${csv(roles).join(', ')}` : 'all roles'}. It takes effect immediately.`}
            </Banner>
            <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
              <Button variant="primary" data-testid="flag-set-confirm-btn" disabled={setBusy} onClick={applyFlag}>Apply change</Button>
              <Button variant="subtle" data-testid="flag-set-cancel" disabled={setBusy} onClick={() => setConfirmSet(false)}>Cancel</Button>
            </div>
          </div>
        )}
        {setMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={setMsg.tone} assertive={setMsg.tone === 'danger'}>{setMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="config-lookup">
        <h3 className="scr__section-title">Published config release (ADM-03)</h3>
        <p className="scr__kpi-meta">Look up the currently published version of a named config release.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Config name" hint="e.g. clinic-hours" data-testid="config-name" value={cfgName} onChange={(e) => setCfgName(e.currentTarget.value)} style={{ minWidth: 240 }} />
          <Button variant="primary" data-testid="config-lookup-btn" disabled={cfgBusy} {...(!cfgName.trim() ? { disabledReason: 'Enter a config name' } : {})} icon={<Icon name="info" />} onClick={lookup}>Look up</Button>
        </div>
        {cfgErr && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone="danger" assertive>{cfgErr}</Banner></div>}
        {cfg === 'none' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="empty" title="No published release" >Nothing is currently published under that name.</StateBlock></div>}
        {cfg && cfg !== 'none' && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <StatusTag tone="success" icon="check">{`Published · version ${cfg.version}`}</StatusTag>
            <pre className="scr__note" data-testid="config-payload" style={{ marginTop: 'var(--sancta-space-2)', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(cfg.payload, null, 2)}</pre>
          </div>
        )}
      </div>
    </section>
  );
}
