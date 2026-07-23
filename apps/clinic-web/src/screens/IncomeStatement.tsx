import { useEffect, useState } from 'react';
import { Banner, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import './screens.css';

type StatementLine = { code: string; name: string; amountMinor: number };
type IncomeStatementData = {
  revenueMinor: number; expensesMinor: number; netResultMinor: number;
  revenueLines: StatementLine[]; expenseLines: StatementLine[];
  reconcilesToTrialBalance: boolean;
};

/**
 * Income statement / P&L (FIN-010). Revenue and expense are derived live from the
 * immutable journal lines and reconcile to the trial balance — never a stored total
 * (§3.2). A read-only report: a safe GET on mount with no scoped id. The net result
 * is computed in front of the reader (revenue − expenses) so the arithmetic is
 * visible, not asserted.
 */
export function IncomeStatement() {
  const [data, setData] = useState<IncomeStatementData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setState('loading');
    void (async () => {
      try {
        setData(await jsonFetch<IncomeStatementData>('/api/finance/income-statement'));
        setState('ready');
      } catch { setState('error'); }
    })();
  }, []);

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading income statement" />;
  if (state === 'error' || !data) return <StateBlock state="stale" title="Income statement unavailable">The clinic hub may be unreachable.</StateBlock>;

  const surplus = data.netResultMinor >= 0;

  return (
    <section className="scr" aria-label="Income statement">
      {data.reconcilesToTrialBalance
        ? <Banner tone="success" title="Reconciles to the trial balance">Every figure ties back to the posted ledger.</Banner>
        : <Banner tone="danger" title="Does NOT reconcile to the trial balance" assertive>The ledger is out of balance — investigate before reporting.</Banner>}

      <div className="scr__kpi-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
        <div className="scr__kpi"><span className="scr__kpi-label">Revenue</span><span className="scr__kpi-value">{money(data.revenueMinor)}</span><span className="scr__kpi-meta">Income earned</span></div>
        <div className="scr__kpi"><span className="scr__kpi-label">Expenses</span><span className="scr__kpi-value">{money(data.expensesMinor)}</span><span className="scr__kpi-meta">Costs incurred</span></div>
        <div className="scr__kpi"><span className="scr__kpi-label">{surplus ? 'Net surplus' : 'Net deficit'}</span><span className="scr__kpi-value">{money(Math.abs(data.netResultMinor))}</span><span className="scr__kpi-meta">Revenue − expenses</span></div>
      </div>

      <h3 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-4)' }}>Revenue</h3>
      {data.revenueLines.length === 0
        ? <StateBlock state="empty" title="No revenue posted" />
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="is-revenue">
              <caption className="sancta-visually-hidden">Revenue by account</caption>
              <thead><tr><th scope="col">Account</th><th scope="col" style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {data.revenueLines.map((r) => (
                  <tr key={r.code}><td>{r.code} · {r.name}</td><td data-numeric style={{ textAlign: 'right' }}>{money(r.amountMinor)}</td></tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                  <td>Total revenue</td><td data-numeric style={{ textAlign: 'right' }}>{money(data.revenueMinor)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

      <h3 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-4)' }}>Expenses</h3>
      {data.expenseLines.length === 0
        ? <StateBlock state="empty" title="No expenses posted" />
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="is-expenses">
              <caption className="sancta-visually-hidden">Expenses by account</caption>
              <thead><tr><th scope="col">Account</th><th scope="col" style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {data.expenseLines.map((r) => (
                  <tr key={r.code}><td>{r.code} · {r.name}</td><td data-numeric style={{ textAlign: 'right' }}>{money(r.amountMinor)}</td></tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                  <td>Total expenses</td><td data-numeric style={{ textAlign: 'right' }}>{money(data.expensesMinor)}</td>
                </tr>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                  <td>{surplus ? 'Net surplus' : 'Net deficit'}</td><td data-numeric style={{ textAlign: 'right' }}>{money(data.netResultMinor)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
    </section>
  );
}
