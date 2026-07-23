import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type Device } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const ADMIN = 'demo-operator';
const TRUST_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { trusted: 'success', registered: 'warning', revoked: 'danger' };

/**
 * Device trust register (ADM-002, UAT-14). Provisioned devices may submit changes;
 * a REVOKED device is blocked from sync at the edge and at cloud ingress, so a lost
 * or stolen device cannot push once revoked. Revocation is a deliberate,
 * confirmed-commit write (§9.2) and is audited; a revoked device stays visible in
 * the register (with its revocation time) rather than disappearing. Reads the device
 * list on open — a no-parameter read present on both the edge and the Worker.
 */
export function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [label, setLabel] = useState('');
  const [version, setVersion] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<Device | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => { const r = await api.devices(); setDevices(r.devices); }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const register = async () => {
    if (!label.trim()) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ deviceId: string }>(
      '/api/devices/register', { label: label.trim(), ...(version.trim() ? { softwareVersion: version.trim() } : {}) }, { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.deviceId) {
      setMsg({ tone: 'success', text: `Device "${label.trim()}" provisioned and trusted. ···${res.data.deviceId.slice(-8)}.` });
      setLabel(''); setVersion(''); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* covered */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was provisioned — retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not register the device (${res.errorCode ?? 'error'}).` });
    }
  };

  const revoke = async (device: Device) => {
    setBusy(true); setMsg(null);
    const res = await mutate<{ ok: true }>(
      '/api/devices/revoke', { deviceId: device.deviceId, user: ADMIN }, { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false); setConfirmRevoke(null);
    if (res.ok) {
      setMsg({ tone: 'success', text: `"${device.label}" revoked — it can no longer sync until re-provisioned.` });
      try { await load(); } catch { /* covered */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — the device was NOT revoked. Retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not revoke the device (${res.errorCode ?? 'error'}).` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading device register" />;
  if (state === 'error') return <StateBlock state="stale" title="Device register unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Device trust register">
      <div className="scr__card" data-testid="dev-register">
        <h3 className="scr__section-title">Provision a device (ADM-02)</h3>
        <p className="scr__kpi-meta">A newly provisioned device is trusted immediately and may sync. Revoke any device that is lost or decommissioned.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Device label" hint="e.g. Reception tablet 2" data-testid="dev-label" value={label} onChange={(e) => setLabel(e.currentTarget.value)} style={{ minWidth: 240 }} />
          <Field label="Software version" optional data-testid="dev-version" value={version} onChange={(e) => setVersion(e.currentTarget.value)} />
          <Button variant="primary" data-testid="dev-register-btn" disabled={busy} {...(!label.trim() ? { disabledReason: 'Enter a device label' } : {})} onClick={register}>Provision</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Registered devices</h3>
          <StatusTag tone="neutral">{`${devices.filter((d) => d.trustState === 'trusted').length} trusted · ${devices.length} total`}</StatusTag>
        </div>
        {devices.length === 0
          ? <StateBlock state="empty" title="No devices provisioned yet" />
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="dev-list">
                <caption className="sancta-visually-hidden">Provisioned devices and their trust state; revoked devices remain listed with their revocation time</caption>
                <thead><tr><th scope="col">Device</th><th scope="col">Version</th><th scope="col">Registered</th><th scope="col">Trust</th><th scope="col"></th></tr></thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.deviceId} data-selected={confirmRevoke?.deviceId === d.deviceId || undefined}>
                      <td>{d.label}</td>
                      <td data-numeric>{d.softwareVersion ?? '—'}</td>
                      <td data-numeric>{d.registeredAt.slice(0, 10)}</td>
                      <td><StatusTag tone={TRUST_TONE[d.trustState] ?? 'neutral'} icon={d.trustState === 'revoked' ? 'alert' : d.trustState === 'trusted' ? 'check' : null}>{d.trustState}</StatusTag></td>
                      <td style={{ textAlign: 'right' }}>
                        {d.trustState !== 'revoked' && <Button variant="secondary" tone="danger" density="compact" data-testid="dev-revoke" disabled={busy} onClick={() => setConfirmRevoke(d)}>Revoke</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        {confirmRevoke && (
          <div className="scr__card" data-testid="dev-revoke-confirm" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Banner tone="danger" title={`Revoke "${confirmRevoke.label}"?`} assertive>
              A revoked device is blocked from sync until it is re-provisioned. This is the right action for a lost or stolen device.
            </Banner>
            <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
              <Button variant="primary" tone="danger" data-testid="dev-revoke-confirm-btn" disabled={busy} onClick={() => revoke(confirmRevoke)}>Revoke device</Button>
              <Button variant="subtle" data-testid="dev-revoke-cancel" disabled={busy} onClick={() => setConfirmRevoke(null)}>Keep trusted</Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
