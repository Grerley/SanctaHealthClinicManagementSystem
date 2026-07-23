import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type ProductMargin = { sku: string; revenueMinor: number; cogsMinor: number; grossMarginMinor: number; marginPct: number };
type Margin = { revenueMinor: number; cogsMinor: number; grossMarginMinor: number; marginPct: number };
type BreakEven = { unitContributionMinor: number; breakEvenUnits: number; breakEvenRevenueMinor: number };
type Recovery = { outstandingMinor: number; recovered: boolean; recoveryMonths: number | null };
type BreakEvenResult = { breakEven: BreakEven; recovery: Recovery | null };

/** Parse a dollar amount into integer minor units (cents); NaN when not a number. */
function toMinor(s: string): number { const n = Number(s.trim()); return Number.isFinite(n) ? Math.round(n * 100) : NaN; }

/**
 * Product margin (FIN-011) and break-even planning (FIN-012). The margin report is
 * a read computed from finalised invoice revenue less ACTUAL stock consumption — no
 * editable total — so it is safe to load on mount and re-query. Break-even is a
 * pure planning calculation posted through the hub; it returns the units/revenue to
 * cover fixed costs and, optionally, the months to recover an up-front investment.
 * The hub rejects a non-contributing unit (price ≤ variable cost) with a stable
 * code; the entry is preserved so the planner can correct the inputs.
 */
export function FinanceMargin() {
  const [products, setProducts] = useState<ProductMargin[]>([]);
  const [total, setTotal] = useState<Margin | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Break-even planning draft (dollar strings; converted to minor on submit).
  const [fixedCost, setFixedCost] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [unitVariable, setUnitVariable] = useState('');
  const [investment, setInvestment] = useState('');
  const [funding, setFunding] = useState('');
  const [monthlyNet, setMonthlyNet] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BreakEvenResult | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const r = await jsonFetch<{ products: ProductMargin[]; total: Margin }>('/api/finance/margin');
      setProducts(r.products); setTotal(r.total); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const fixedMinor = toMinor(fixedCost);
  const priceMinor = toMinor(unitPrice);
  const variableMinor = toMinor(unitVariable);
  const baseReady = Number.isFinite(fixedMinor) && Number.isFinite(priceMinor) && Number.isFinite(variableMinor) && fixedCost.trim() !== '' && unitPrice.trim() !== '' && unitVariable.trim() !== '';
  const wantRecovery = investment.trim() !== '';

  const compute = async () => {
    if (!baseReady) return;
    setBusy(true); setMsg(null); setResult(null);
    const body = {
      fixedCostMinor: fixedMinor,
      unitPriceMinor: priceMinor,
      unitVariableCostMinor: variableMinor,
      ...(wantRecovery && Number.isFinite(toMinor(investment)) ? { investmentMinor: toMinor(investment) } : {}),
      ...(wantRecovery && funding.trim() !== '' && Number.isFinite(toMinor(funding)) ? { fundingMinor: toMinor(funding) } : {}),
      ...(wantRecovery && monthlyNet.trim() !== '' && Number.isFinite(toMinor(monthlyNet)) ? { monthlyNetMinor: toMinor(monthlyNet) } : {}),
    };
    const res = await mutate<BreakEvenResult>('/api/finance/break-even', body, { idempotencyKey: idem });
    setBusy(false);
    if (res.ok && res.data) {
      setResult(res.data);
      setMsg({ tone: 'success', text: `Break-even is ${res.data.breakEven.breakEvenUnits} units at $${money(res.data.breakEven.breakEvenRevenueMinor)} revenue.` });
      setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else if (res.errorCode === 'break_even_unreachable') {
      setMsg({ tone: 'danger', text: 'No positive contribution margin — the unit price must exceed its variable cost for a break-even to exist. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not compute break-even (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Margin and break-even">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Product margin (FIN-011)</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="mrg-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          {total && <StatusTag tone={total.grossMarginMinor >= 0 ? 'success' : 'danger'} icon={total.grossMarginMinor >= 0 ? 'check' : 'alert'}>{`Total margin $${money(total.grossMarginMinor)} · ${total.marginPct.toFixed(1)}%`}</StatusTag>}
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading margin report" />}
        {state === 'error' && <StateBlock state="stale" title="Margin report unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          products.length === 0
            ? <StateBlock state="empty" title="No margin data yet">There is no finalised revenue with matched consumption to report on.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="mrg-list">
                  <caption className="sancta-visually-hidden">Gross margin by product from revenue less actual cost of goods</caption>
                  <thead><tr>
                    <th scope="col">SKU</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Revenue</th>
                    <th scope="col" style={{ textAlign: 'right' }}>COGS</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Gross margin</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Margin %</th>
                  </tr></thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.sku}>
                        <td>{p.sku}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{`$${money(p.revenueMinor)}`}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{`$${money(p.cogsMinor)}`}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{`$${money(p.grossMarginMinor)}`}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{`${p.marginPct.toFixed(1)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                  {total && (
                    <tfoot>
                      <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                        <td>Clinic total</td>
                        <td data-numeric style={{ textAlign: 'right' }} data-testid="mrg-total-revenue">{`$${money(total.revenueMinor)}`}</td>
                        <td data-numeric style={{ textAlign: 'right' }} data-testid="mrg-total-cogs">{`$${money(total.cogsMinor)}`}</td>
                        <td data-numeric style={{ textAlign: 'right' }} data-testid="mrg-total-margin">{`$${money(total.grossMarginMinor)}`}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{`${total.marginPct.toFixed(1)}%`}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="be-form">
        <h3 className="scr__section-title">Break-even &amp; investment recovery (FIN-012)</h3>
        <p className="scr__kpi-meta">Contribution per unit (price − variable cost) drives break-even. Optionally add an up-front investment to see the months to recover it from monthly net surplus. All amounts are in dollars.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Fixed cost" numeric prefix="$" hint="Total fixed cost to cover" data-testid="be-fixed" value={fixedCost} onChange={(e) => setFixedCost(e.currentTarget.value)} />
          <Field label="Unit price" numeric prefix="$" hint="Selling price per unit" data-testid="be-price" value={unitPrice} onChange={(e) => setUnitPrice(e.currentTarget.value)} />
          <Field label="Unit variable cost" numeric prefix="$" hint="Variable cost per unit" data-testid="be-variable" value={unitVariable} onChange={(e) => setUnitVariable(e.currentTarget.value)} />
          <Field label="Investment" optional numeric prefix="$" hint="Up-front investment to recover" data-testid="be-investment" value={investment} onChange={(e) => setInvestment(e.currentTarget.value)} />
          <Field label="Funding" optional numeric prefix="$" hint="Funding that offsets the investment" data-testid="be-funding" value={funding} onChange={(e) => setFunding(e.currentTarget.value)} />
          <Field label="Monthly net surplus" optional numeric prefix="$" hint="Surplus available each month" data-testid="be-monthly" value={monthlyNet} onChange={(e) => setMonthlyNet(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="be-submit" disabled={busy}
            {...(!baseReady ? { disabledReason: 'Enter fixed cost, unit price and unit variable cost' } : {})}
            onClick={compute}>Compute break-even</Button>
        </div>
        {result && (
          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <table className="scr__table" data-testid="be-result">
              <caption className="sancta-visually-hidden">Break-even and investment-recovery result</caption>
              <thead><tr><th scope="col">Measure</th><th scope="col" style={{ textAlign: 'right' }}>Value</th></tr></thead>
              <tbody>
                <tr><td>Unit contribution</td><td data-numeric style={{ textAlign: 'right' }}>{`$${money(result.breakEven.unitContributionMinor)}`}</td></tr>
                <tr><td>Break-even units</td><td data-numeric style={{ textAlign: 'right' }}>{`${result.breakEven.breakEvenUnits}`}</td></tr>
                <tr><td>Break-even revenue</td><td data-numeric style={{ textAlign: 'right' }}>{`$${money(result.breakEven.breakEvenRevenueMinor)}`}</td></tr>
                {result.recovery && <tr><td>Outstanding to recover</td><td data-numeric style={{ textAlign: 'right' }}>{`$${money(result.recovery.outstandingMinor)}`}</td></tr>}
                {result.recovery && <tr><td>Recovery months</td><td data-numeric style={{ textAlign: 'right' }}>{result.recovery.recovered ? 'recovered' : result.recovery.recoveryMonths === null ? 'never (no monthly surplus)' : `${result.recovery.recoveryMonths}`}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
