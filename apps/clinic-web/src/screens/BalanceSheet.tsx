import { useEffect, useState } from 'react';
import { Banner, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import './screens.css';

type BsLine = { code: string; name: string; type: string; amountMinor: number };
type BalanceSheetData = {
  asOfPeriod: string | null; assetsMinor: number; liabilitiesMinor: number; equityMinor: number;
  retainedAndCurrentEarningsMinor: number; balances: boolean; lines: BsLine[];
};

const SECTIONS: Array<{ type: string; title: string }> = [
  { type: 'asset', title: 'Assets' },
  { type: 'liability', title: 'Liabilities' },
  { type: 'equity', title: 'Equity' },
];

/**
 * Balance sheet (FIN-010). Assets, liabilities and equity derive from the same
 * immutable ledger and MUST satisfy the double-entry identity (assets = liabilities
 * + equity) — never a stored total (§3.2). Equity includes current (unclosed)
 * earnings, so it balances whether or not the period has been closed. A safe GET on
 * mount, no scoped id.
 */
export function BalanceSheet() {
  const [data, setData] = useState<BalanceSheetData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setState('loading');
    void (async () => {
      try {
        setData(await jsonFetch<BalanceSheetData>('/api/finance/balance-sheet'));
        setState('ready');
      } catch { setState('error'); }
    })();
  }, []);

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading balance sheet" />;
  if (state === 'error' || !data) return <StateBlock state="stale" title="Balance sheet unavailable">The clinic hub may be unreachable.</StateBlock>;

  const rightSide = data.liabilitiesMinor + data.equityMinor;

  return (
    <section className="scr" aria-label="Balance sheet">
      {data.balances
        ? <Banner tone="success" title="Balance sheet balances">Assets {money(data.assetsMinor)} equal liabilities plus equity {money(rightSide)}.</Banner>
        : <Banner tone="danger" title="Balance sheet does NOT balance" assertive>Assets {money(data.assetsMinor)} ≠ liabilities + equity {money(rightSide)} — investigate before reporting.</Banner>}

      <div className="scr__kpi-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
        <div className="scr__kpi"><span className="scr__kpi-label">Assets</span><span className="scr__kpi-value">{money(data.assetsMinor)}</span><span className="scr__kpi-meta">What the clinic owns</span></div>
        <div className="scr__kpi"><span className="scr__kpi-label">Liabilities</span><span className="scr__kpi-value">{money(data.liabilitiesMinor)}</span><span className="scr__kpi-meta">What it owes</span></div>
        <div className="scr__kpi"><span className="scr__kpi-label">Equity</span><span className="scr__kpi-value">{money(data.equityMinor)}</span><span className="scr__kpi-meta">Incl. earnings {money(data.retainedAndCurrentEarningsMinor)}</span></div>
      </div>

      {SECTIONS.map((sec) => {
        const rows = data.lines.filter((l) => l.type === sec.type);
        const total = sec.type === 'asset' ? data.assetsMinor : sec.type === 'liability' ? data.liabilitiesMinor : data.equityMinor;
        return (
          <div key={sec.type}>
            <h3 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-4)' }}>{sec.title}</h3>
            {rows.length === 0
              ? <StateBlock state="empty" title={`No ${sec.title.toLowerCase()} posted`} />
              : (
                <div className="scr__table-scroll">
                  <table className="scr__table" data-testid={`bs-${sec.type}`}>
                    <caption className="sancta-visually-hidden">{sec.title} by account</caption>
                    <thead><tr><th scope="col">Account</th><th scope="col" style={{ textAlign: 'right' }}>Amount</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.code}><td>{r.code} · {r.name}</td><td data-numeric style={{ textAlign: 'right' }}>{money(r.amountMinor)}</td></tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                        <td>Total {sec.title.toLowerCase()}</td><td data-numeric style={{ textAlign: 'right' }}>{money(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
          </div>
        );
      })}
    </section>
  );
}
