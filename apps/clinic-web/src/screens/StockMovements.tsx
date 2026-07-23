import { useCallback, useEffect, useState } from 'react';
import { Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type MovementRow = { sku: string; name: string; receivedQty: number; dispensedQty: number; adjustmentQty: number; netQty: number };
type MovementReport = { from: string; to: string; rows: MovementRow[] };

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function daysAgo(n: number): string { return isoDate(new Date(Date.now() - n * 86_400_000)); }
function daysAhead(n: number): string { return isoDate(new Date(Date.now() + n * 86_400_000)); }

/**
 * Stock movement / consumption & wastage report (INV-011). Quantities are summed by
 * movement type straight from the immutable movement records — never a stored total.
 * Receipts add stock, dispenses consume it, and negative adjustments are losses
 * (wastage / stocktake shrinkage). The read is scoped by a date RANGE only (no uuid),
 * so it is safe to run on mount and to re-query as the range changes.
 */
export function StockMovements() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(daysAhead(1)); // exclusive end — includes today
  const [report, setReport] = useState<MovementReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async (f: string, t: string) => {
    setState('loading');
    try {
      const r = await jsonFetch<MovementReport>(`/api/stock/movement-report?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`);
      setReport(r); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(from, to); /* initial range */ }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = report?.rows ?? [];
  const totals = rows.reduce(
    (a, r) => ({ received: a.received + r.receivedQty, dispensed: a.dispensed + r.dispensedQty, adjustment: a.adjustment + r.adjustmentQty, net: a.net + r.netQty }),
    { received: 0, dispensed: 0, adjustment: 0, net: 0 },
  );
  const rangeValid = from.trim() !== '' && to.trim() !== '' && from <= to;

  return (
    <section className="scr" aria-label="Stock movements">
      <div className="scr__toolbar">
        <Field label="From" type="date" hint="Inclusive" data-testid="mov-from" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
        <Field label="To" type="date" hint="Exclusive end" data-testid="mov-to" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        <Button variant="primary" icon={<Icon name="sync" />} data-testid="mov-run" disabled={state === 'loading'}
          {...(!rangeValid ? { disabledReason: 'Choose a from date on or before the to date' } : {})}
          onClick={() => void load(from, to)}>Run report</Button>
      </div>

      {state === 'loading' && <StateBlock state="initial-loading" title="Loading movement report" />}
      {state === 'error' && <StateBlock state="stale" title="Report unavailable">The clinic hub may be unreachable.</StateBlock>}
      {state === 'ready' && (
        <div>
          <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
            <h3 className="scr__section-title">Consumption &amp; wastage (INV-011)</h3>
            <StatusTag tone={rows.length > 0 ? 'neutral' : 'success'} icon={rows.length > 0 ? 'info' : 'check'}>
              {rows.length > 0 ? `${rows.length} items moved` : 'No movements in range'}
            </StatusTag>
          </div>
          {rows.length === 0
            ? <StateBlock state="empty" title="No movements">Nothing was received, dispensed or adjusted in this date range.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="mov-table">
                  <caption className="sancta-visually-hidden">Stock quantities received, dispensed and adjusted by item over the selected range</caption>
                  <thead>
                    <tr>
                      <th scope="col">SKU</th><th scope="col">Item</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Received</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Dispensed</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Adjustment</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.sku}>
                        <td data-numeric>{r.sku}</td>
                        <td>{r.name}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{r.receivedQty}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{r.dispensedQty}</td>
                        <td data-numeric style={{ textAlign: 'right', color: r.adjustmentQty < 0 ? 'var(--sancta-colour-danger)' : undefined }}>{r.adjustmentQty > 0 ? '+' : ''}{r.adjustmentQty}</td>
                        <td data-numeric style={{ textAlign: 'right', fontWeight: 700 }}>{r.netQty > 0 ? '+' : ''}{r.netQty}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                      <td>Totals</td><td></td>
                      <td data-numeric style={{ textAlign: 'right' }} data-testid="mov-total-received">{totals.received}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{totals.dispensed}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{totals.adjustment > 0 ? '+' : ''}{totals.adjustment}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{totals.net > 0 ? '+' : ''}{totals.net}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
        </div>
      )}
    </section>
  );
}
