import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type SiteRow = { id: string; code: string; name: string; isCentral: boolean; active: boolean };

/**
 * Multi-site registry (OPS-008). Sites are reference data; the list is scoped by
 * the caller's authorisation — a central role sees the whole network, a local user
 * sees their own site — which the edge applies server-side. Registering a site is
 * an additive provisioning action carried as a confirmed-commit write (§9.2): a
 * duplicate code is rejected by the hub and the draft is preserved so nothing typed
 * is lost. Reads /api/sites on open (a no-parameter read present on both the edge
 * and the Worker).
 */
export function SiteRegistry() {
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [isCentral, setIsCentral] = useState(false);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => { const r = await jsonFetch<{ sites: SiteRow[] }>('/api/sites'); setSites(r.sites); }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const register = async () => {
    if (!code.trim() || !name.trim()) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/sites',
      { code: code.trim(), name: name.trim(), isCentral },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `Site "${name.trim()}" (${code.trim()}) registered.` });
      setCode(''); setName(''); setIsCentral(false); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* covered */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — the site was NOT registered. Retry when connected.' });
    } else if (res.errorCode === 'site_rejected') {
      setMsg({ tone: 'danger', text: 'The hub rejected this site — the code may already be in use, or the details are incomplete.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not register the site (${res.errorCode ?? 'error'}).` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading site registry" />;
  if (state === 'error') return <StateBlock state="stale" title="Site registry unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Site registry">
      <div className="scr__card" data-testid="site-register">
        <h3 className="scr__section-title">Register a site (OPS-08)</h3>
        <p className="scr__kpi-meta">A central site coordinates the network; local sites hold their own patients. Codes are unique — a duplicate is rejected.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Site code" hint="short, e.g. HQ or KLA-01" data-testid="site-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Site name" data-testid="site-name" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ minWidth: 240 }} />
          <div className="scr__seg" role="group" aria-label="Site kind">
            <button type="button" className="scr__seg-btn sancta-focusable" data-testid="site-central-no" data-active={!isCentral} aria-pressed={!isCentral} onClick={() => setIsCentral(false)}>Local</button>
            <button type="button" className="scr__seg-btn sancta-focusable" data-testid="site-central-yes" data-active={isCentral} aria-pressed={isCentral} onClick={() => setIsCentral(true)}>Central</button>
          </div>
          <Button variant="primary" data-testid="site-register-btn" disabled={busy} {...(!code.trim() || !name.trim() ? { disabledReason: 'Enter a site code and name' } : {})} icon={<Icon name="linked" />} onClick={register}>Register</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Sites you can see</h3>
          <StatusTag tone="neutral">{`${sites.filter((s) => s.active).length} active · ${sites.length} total`}</StatusTag>
        </div>
        {sites.length === 0
          ? <StateBlock state="empty" title="No sites visible">Your role may be scoped to a single site that is not yet registered.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="site-list">
                <caption className="sancta-visually-hidden">Sites visible to you, scoped by your authorisation</caption>
                <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {sites.map((s) => (
                    <tr key={s.id}>
                      <td data-numeric>{s.code}</td>
                      <td>{s.name}</td>
                      <td><StatusTag tone={s.isCentral ? 'info' : 'neutral'} icon={s.isCentral ? 'linked' : null}>{s.isCentral ? 'Central' : 'Local'}</StatusTag></td>
                      <td><StatusTag tone={s.active ? 'success' : 'warning'} icon={s.active ? 'check' : 'alert'}>{s.active ? 'active' : 'inactive'}</StatusTag></td>
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
