import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import './screens.css';

type LedgerLine = {
  batchId: string; sourceType: string; sourceId: string; postingDate: string;
  accountCode: string; debitMinor: number; creditMinor: number; costCentre: string | null;
};
type LedgerExport = {
  periodId: string; periodStatus: string; lines: LedgerLine[];
  totalDebitMinor: number; totalCreditMinor: number; balanced: boolean;
  lineCount: number; idempotencyKey: string; exportedAt: string;
};

/**
 * General ledger — approved journal-line detail for a period (FIN-014). A
 * user-driven read: the clerk enters the period id (e.g. 2026-07) and pulls the full
 * posted line detail behind the summary reports, grouped by account. The export is
 * deterministic (a SHA-256 over accounting content), so the same period always yields
 * the same idempotency key — shown so a downstream reconciliation can prove it hasn't
 * changed. Every line ties to its source document; the export refuses to return an
 * unbalanced ledger (422), surfaced here rather than hidden.
 */
export function GeneralLedger() {
  const [periodId, setPeriodId] = useState('');
  const [data, setData] = useState<LedgerExport | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errText, setErrText] = useState('');

  const canLoad = /^\d{4}-\d{2}$/.test(periodId.trim());

  const load = async () => {
    if (!canLoad) return;
    setState('loading'); setErrText('');
    try {
      const r = await jsonFetch<LedgerExport & { error?: { code: string; message: string } }>(`/api/finance/ledger-export?periodId=${encodeURIComponent(periodId.trim())}`);
      if ('error' in r && r.error) { setState('error'); setErrText(r.error.message); return; }
      setData(r); setState('ready');
    } catch { setState('error'); setErrText('The clinic hub may be unreachable, or the ledger for this period does not balance.'); }
  };

  // Group lines by account for a readable ledger; sub-total each account.
  const byAccount = data ? Array.from(
    data.lines.reduce((m, l) => {
      const g = m.get(l.accountCode) ?? { lines: [] as LedgerLine[], debit: 0, credit: 0 };
      g.lines.push(l); g.debit += l.debitMinor; g.credit += l.creditMinor;
      m.set(l.accountCode, g); return m;
    }, new Map<string, { lines: LedgerLine[]; debit: number; credit: number }>()),
  ) : [];

  return (
    <section className="scr" aria-label="General ledger">
      <div className="scr__row" style={{ alignItems: 'flex-end' }}>
        <Field label="Financial period" hint="Year-month, e.g. 2026-07" data-testid="gl-period" value={periodId}
          onChange={(e) => setPeriodId(e.currentTarget.value)} style={{ maxWidth: 220 }} />
        <Button variant="primary" data-testid="gl-load"
          {...(canLoad ? {} : { disabledReason: 'Enter a period as year-month (e.g. 2026-07)' })}
          onClick={load}>Load ledger</Button>
      </div>

      {state === 'loading' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="initial-loading" title="Loading general ledger" /></div>}
      {state === 'error' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="stale" title="Ledger unavailable">{errText}</StateBlock></div>}
      {state === 'idle' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="empty" title="Enter a period to view its ledger">The general ledger shows every approved journal line behind the summary reports.</StateBlock></div>}

      {state === 'ready' && data && (
        <div data-testid="gl-result">
          <div className="scr__toolbar" style={{ justifyContent: 'space-between', marginTop: 'var(--sancta-space-3)' }}>
            <StatusTag tone={data.periodStatus === 'hard_close' ? 'neutral' : 'success'} icon={data.periodStatus === 'hard_close' ? 'lock' : 'check'}>
              {`Period ${data.periodId} · ${data.periodStatus === 'hard_close' ? 'closed' : 'open'}`}
            </StatusTag>
            <span className="scr__kpi-meta">{`${data.lineCount} lines · key ${data.idempotencyKey.slice(0, 12)}…`}</span>
          </div>

          {data.balanced
            ? <Banner tone="success" title="Ledger balances">Total debits equal total credits ({money(data.totalDebitMinor)}).</Banner>
            : <Banner tone="danger" title="Ledger does NOT balance" assertive>Debits {money(data.totalDebitMinor)} ≠ credits {money(data.totalCreditMinor)}.</Banner>}

          {data.lines.length === 0
            ? <StateBlock state="empty" title="No posted lines for this period" />
            : byAccount.map(([code, g]) => (
              <div key={code}>
                <h3 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-4)' }}>{code}</h3>
                <div className="scr__table-scroll">
                  <table className="scr__table">
                    <caption className="sancta-visually-hidden">Journal lines for account {code}</caption>
                    <thead><tr><th scope="col">Date</th><th scope="col">Source</th><th scope="col">Cost centre</th><th scope="col" style={{ textAlign: 'right' }}>Debit</th><th scope="col" style={{ textAlign: 'right' }}>Credit</th></tr></thead>
                    <tbody>
                      {g.lines.map((l, i) => (
                        <tr key={`${l.batchId}-${i}`}>
                          <td data-numeric>{l.postingDate}</td>
                          <td>{l.sourceType} · {l.sourceId.slice(0, 8)}</td>
                          <td>{l.costCentre ?? '—'}</td>
                          <td data-numeric style={{ textAlign: 'right' }}>{l.debitMinor ? money(l.debitMinor) : ''}</td>
                          <td data-numeric style={{ textAlign: 'right' }}>{l.creditMinor ? money(l.creditMinor) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                        <td colSpan={3}>Account total</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{money(g.debit)}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{money(g.credit)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            ))}

          {data.lines.length > 0 && (
            <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-4)' }}>
              <table className="scr__table">
                <caption className="sancta-visually-hidden">Ledger totals</caption>
                <thead><tr><th scope="col">Ledger total</th><th scope="col" style={{ textAlign: 'right' }}>Debit</th><th scope="col" style={{ textAlign: 'right' }}>Credit</th></tr></thead>
                <tfoot>
                  <tr style={{ fontWeight: 700 }}>
                    <td>All accounts</td>
                    <td data-numeric style={{ textAlign: 'right' }}>{money(data.totalDebitMinor)}</td>
                    <td data-numeric style={{ textAlign: 'right' }}>{money(data.totalCreditMinor)}</td>
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
