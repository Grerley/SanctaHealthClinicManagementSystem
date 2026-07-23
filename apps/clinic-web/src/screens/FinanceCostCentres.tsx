import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type CostCentre = { code: string; name: string; active: boolean };

/**
 * Cost-centre registry (FIN-001). Cost centres are reference data governed as
 * configuration — the posting choke point rejects an unknown or inactive centre, so
 * the registry is a controlled list, not free text. The list is a plain read (no
 * uuid scope) so it is safe to load on mount and re-query after a change. Creating a
 * centre is a §9.2 confirmed-commit write (idempotency key per intent, draft kept on
 * failure); the list reloads only after the hub durably accepts it.
 */
export function FinanceCostCentres() {
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const r = await jsonFetch<{ costCentres: CostCentre[] }>('/api/finance/cost-centres');
      setCentres(r.costCentres); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (code.trim() === '' || name.trim() === '') return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ code: string }>(
      '/api/finance/cost-centre',
      { code: code.trim(), name: name.trim() },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Cost centre "${name.trim()}" created.` });
      setCode(''); setName(''); setIdem(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not create the cost centre (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const activeCount = centres.filter((c) => c.active).length;

  return (
    <section className="scr" aria-label="Cost centres">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Cost-centre registry (FIN-001)</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="cc-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          <StatusTag tone={activeCount > 0 ? 'success' : 'neutral'} icon={activeCount > 0 ? 'check' : 'info'}>
            {`${activeCount} active`}
          </StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading cost centres" />}
        {state === 'error' && <StateBlock state="stale" title="Cost centres unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          centres.length === 0
            ? <StateBlock state="empty" title="No cost centres yet">Create one below; postings can then be attributed to it.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="cc-list">
                  <caption className="sancta-visually-hidden">Cost centres with their active status</caption>
                  <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {centres.map((c) => (
                      <tr key={c.code}>
                        <td data-numeric>{c.code}</td>
                        <td>{c.name}</td>
                        <td><StatusTag tone={c.active ? 'success' : 'neutral'} icon={c.active ? 'check' : null}>{c.active ? 'active' : 'inactive'}</StatusTag></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="cc-form">
        <h3 className="scr__section-title">Create a cost centre</h3>
        <p className="scr__kpi-meta">A cost centre is a controlled code postings can be attributed to. The clinic hub rejects a duplicate code.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Code" hint="Short unique identifier" data-testid="cc-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Name" hint="What this cost centre is" data-testid="cc-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="cc-submit" disabled={busy}
            {...(code.trim() === '' ? { disabledReason: 'Enter the cost-centre code' } : name.trim() === '' ? { disabledReason: 'Enter the cost-centre name' } : {})}
            onClick={create}>Create cost centre</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
