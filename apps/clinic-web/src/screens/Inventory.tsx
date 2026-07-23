import { useEffect, useState } from 'react';
import { StatusTag, StateBlock } from '@sancta/ui';
import { api, type StockAlert, type ReorderSuggestion } from '../api.ts';
import './screens.css';

const FLAG_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = { stockout: 'danger', expired: 'danger', low: 'warning', near_expiry: 'warning' };
const FLAG_LABEL: Record<string, string> = { stockout: 'Out of stock', expired: 'Expired', low: 'Low', near_expiry: 'Near expiry' };

/**
 * Inventory overview (INV-01) + expiry/low-stock worklist (INV-08). Balances are
 * derived from append-only movements (§3.3), never a stored total. Expired and
 * near-expiry lots are flagged so they can be blocked from issue; reorder
 * suggestions are ADVISORY only — the system never auto-orders (INV-007).
 */
export function Inventory() {
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setState('loading');
    void (async () => {
      try {
        const [a, s] = await Promise.all([api.stockAlerts(), api.reorderSuggestions()]);
        setAlerts(a.alerts); setSuggestions(s.suggestions); setState('ready');
      } catch { setState('error'); }
    })();
  }, []);

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading inventory" />;
  if (state === 'error') return <StateBlock state="stale" title="Inventory unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Inventory">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Stock alerts (INV-08)</h3>
          <StatusTag tone={alerts.length > 0 ? 'warning' : 'success'} icon={alerts.length > 0 ? 'alert' : 'check'}>
            {alerts.length > 0 ? `${alerts.length} to review` : 'All within range'}
          </StatusTag>
        </div>
        {alerts.length === 0
          ? <StateBlock state="empty" title="No stock alerts">Every managed item is in range and none is expiring soon.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="inv-alerts">
                <caption className="sancta-visually-hidden">Stock items that are out, low, expired or near expiry</caption>
                <thead><tr><th scope="col">SKU</th><th scope="col">Item</th><th scope="col" style={{ textAlign: 'right' }}>On hand</th><th scope="col" style={{ textAlign: 'right' }}>Reorder min</th><th scope="col">Flags</th></tr></thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.sku}>
                      <td data-numeric>{a.sku}</td>
                      <td>{a.name}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{a.onHand}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{a.reorderMin ?? '—'}</td>
                      <td style={{ display: 'flex', gap: 'var(--sancta-space-1)', flexWrap: 'wrap' }}>
                        {a.flags.map((f) => <StatusTag key={f} tone={FLAG_TONE[f] ?? 'neutral'} icon={FLAG_TONE[f] === 'danger' ? 'alert' : null}>{FLAG_LABEL[f] ?? f}</StatusTag>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <div>
        <h3 className="scr__section-title">Reorder suggestions (INV-07 — advisory, never auto-ordered)</h3>
        {suggestions.length === 0
          ? <StateBlock state="empty" title="Nothing to reorder" />
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="inv-reorder">
                <caption className="sancta-visually-hidden">Suggested reorder quantities to bring stock up to maximum</caption>
                <thead><tr><th scope="col">SKU</th><th scope="col" style={{ textAlign: 'right' }}>Suggested qty</th><th scope="col" style={{ textAlign: 'right' }}>Days cover</th><th scope="col">Assumptions</th></tr></thead>
                <tbody>
                  {suggestions.map((s) => (
                    <tr key={s.sku}>
                      <td data-numeric>{s.sku}</td>
                      <td data-numeric style={{ textAlign: 'right' }}><strong>{s.suggestedQty}</strong></td>
                      <td data-numeric style={{ textAlign: 'right' }}>{s.coverDays ?? '—'}</td>
                      <td className="scr__kpi-meta">min {s.assumptions.reorderMin ?? '—'} · max {s.assumptions.reorderMax ?? '—'}{s.assumptions.avgDailyUse ? ` · ${s.assumptions.avgDailyUse}/day` : ''}</td>
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
