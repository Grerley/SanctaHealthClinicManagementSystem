import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const USER = 'demo-operator';

type Unmatched = { id: string; orderRef: string; value: number | null; source: string | null };

/**
 * Unmatched external results (ORD-007). A facility-wide work queue of results that
 * arrived from outside but could not be auto-linked to an order. Each row is cleared
 * by reconciling it to a specific order (POST /api/orders/external-result/reconcile),
 * which is a confirmed-commit write (§9.2): the row only leaves the queue once the
 * hub durably accepts the match, and the operator's entry is preserved on failure.
 * Reconciliation is audited, so a result is never silently attached — an operator
 * chooses the order it belongs to. Read-only until an order id is supplied.
 */
export function UnmatchedResults() {
  const [items, setItems] = useState<Unmatched[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [serviceRequestId, setServiceRequestId] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await jsonFetch<{ unmatched: Unmatched[] }>('/api/orders/unmatched');
    setItems(r.unmatched);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const reconcile = async (item: Unmatched) => {
    if (serviceRequestId.trim() === '') return;
    setBusyId(item.id); setMsg(null);
    const res = await mutate<{ id: string; status: 'matched' }>(
      '/api/orders/external-result/reconcile',
      { externalResultId: item.id, serviceRequestId: serviceRequestId.trim(), by: USER },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusyId(null);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Reconciled result ···${item.id.slice(-8)} to order ···${serviceRequestId.trim().slice(-8)}. Cleared from the queue.` });
      setTargetId(null); setServiceRequestId('');
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. The result is still unmatched.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not reconcile (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). The result is still unmatched.` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading unmatched results" />;
  if (state === 'error') return <StateBlock state="stale" title="Unmatched queue unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Unmatched results">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Unmatched results (ORD-007)</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="ur-refresh" disabled={state !== 'ready'} onClick={() => { setState('loading'); void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })(); }}>Refresh</Button>
          </div>
          <StatusTag tone={items.length > 0 ? 'warning' : 'success'} icon={items.length > 0 ? 'alert' : 'check'}>{items.length > 0 ? `${items.length} unmatched` : 'All matched'}</StatusTag>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      {items.length === 0
        ? <StateBlock state="empty" title="No unmatched results">Every external result has been linked to an order.</StateBlock>
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="ur-table">
              <caption className="sancta-visually-hidden">External results awaiting reconciliation to an order, oldest first. Reconcile links a result to a specific order id.</caption>
              <thead><tr><th scope="col">Result</th><th scope="col">Order ref</th><th scope="col">Value</th><th scope="col">Source</th><th scope="col"></th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} data-selected={targetId === it.id || undefined}>
                    <td data-numeric>···{it.id.slice(-8)}</td>
                    <td>{it.orderRef}</td>
                    <td data-numeric>{it.value === null ? '—' : it.value}</td>
                    <td>{it.source ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {targetId === it.id
                        ? (
                          <div className="scr__row" style={{ alignItems: 'flex-end', justifyContent: 'flex-end' }}>
                            <Field label="Order id" hideLabel hint="Order to link this result to" data-testid="ur-order-id" value={serviceRequestId} onChange={(e) => setServiceRequestId(e.currentTarget.value)} />
                            <Button variant="primary" density="compact" data-testid="ur-reconcile-confirm" disabled={busyId === it.id}
                              {...(serviceRequestId.trim() === '' ? { disabledReason: 'Enter the order id to link to' } : {})}
                              onClick={() => reconcile(it)}>Reconcile</Button>
                            <Button variant="subtle" density="compact" data-testid="ur-reconcile-cancel" onClick={() => { setTargetId(null); setServiceRequestId(''); }}>Cancel</Button>
                          </div>
                        )
                        : <Button variant="secondary" density="compact" data-testid="ur-reconcile-start" onClick={() => { setTargetId(it.id); setServiceRequestId(''); setMsg(null); }}>Reconcile</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
