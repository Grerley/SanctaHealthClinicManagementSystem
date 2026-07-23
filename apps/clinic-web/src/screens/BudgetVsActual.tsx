import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type VarianceRow = { accountCode: string; name: string; budgetMinor: number; actualMinor: number; varianceMinor: number; variancePct: number | null };
type VarianceReport = { periodId: string; rows: VarianceRow[]; totalBudgetMinor: number; totalActualMinor: number };

/**
 * Budget vs actual (FIN-007). Actual is the account's debit-positive net posted to
 * the journal lines in the period, so the variance always reconciles to the general
 * ledger — never a stored figure. A read by period id (year-month string) is safe.
 * Setting a budget line is a `configure`-gated control: the amount is entered in
 * cents and posted via the §9.2 confirmed-commit contract; the server enforces the
 * permission authoritatively (a 403 is surfaced, the draft kept).
 */
export function BudgetVsActual() {
  const [periodId, setPeriodId] = useState('');
  const [report, setReport] = useState<VarianceReport | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // Set-budget draft (§9.2 — preserved across a failed commit).
  const [accountCode, setAccountCode] = useState('');
  const [amount, setAmount] = useState<number>(0);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const canLoad = /^\d{4}-\d{2}$/.test(periodId.trim());

  const load = async () => {
    if (!canLoad) return;
    setState('loading'); setMsg(null);
    try {
      setReport(await jsonFetch<VarianceReport>(`/api/finance/budget-variance?periodId=${encodeURIComponent(periodId.trim())}`));
      setState('ready');
    } catch { setState('error'); }
  };

  const setBudget = async () => {
    if (!report || !accountCode.trim() || !Number.isInteger(amount)) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string }>('/api/finance/budget',
      { accountCode: accountCode.trim(), periodId: report.periodId, amountMinor: Math.round(amount) },
      { idempotencyKey: idemKey });
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Budget of ${money(Math.round(amount))} set for ${accountCode.trim()} in ${report.periodId}.` });
      setAccountCode(''); setAmount(0); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.status === 403) {
      setMsg({ tone: 'danger', text: 'You do not have permission to set a budget — a finance role is required. Your entry is kept.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was saved — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Budget rejected (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const varianceTone = (v: number): 'neutral' | 'warning' | 'danger' => (v === 0 ? 'neutral' : Math.abs(v) > 0 ? 'warning' : 'neutral');
  const totalVariance = report ? report.totalActualMinor - report.totalBudgetMinor : 0;

  return (
    <section className="scr" aria-label="Budget versus actual">
      <div className="scr__row" style={{ alignItems: 'flex-end' }}>
        <Field label="Financial period" hint="Year-month, e.g. 2026-07" data-testid="bva-period" value={periodId}
          onChange={(e) => setPeriodId(e.currentTarget.value)} style={{ maxWidth: 220 }} />
        <Button variant="primary" data-testid="bva-load"
          {...(canLoad ? {} : { disabledReason: 'Enter a period as year-month (e.g. 2026-07)' })}
          onClick={load}>Load variance</Button>
      </div>

      {state === 'loading' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="initial-loading" title="Loading budget variance" /></div>}
      {state === 'error' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="stale" title="Variance unavailable">The clinic hub may be unreachable.</StateBlock></div>}
      {state === 'idle' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="empty" title="Enter a period to compare budget to actual">Actual figures are read live from the general ledger.</StateBlock></div>}

      {state === 'ready' && report && (
        <div data-testid="bva-result">
          {report.rows.length === 0
            ? <StateBlock state="empty" title="No budget lines for this period">Set a budget line below to start tracking variance.</StateBlock>
            : (
              <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
                <table className="scr__table" data-testid="bva-table">
                  <caption className="sancta-visually-hidden">Budget versus actual by account for {report.periodId}</caption>
                  <thead><tr><th scope="col">Account</th><th scope="col" style={{ textAlign: 'right' }}>Budget</th><th scope="col" style={{ textAlign: 'right' }}>Actual</th><th scope="col" style={{ textAlign: 'right' }}>Variance</th><th scope="col" style={{ textAlign: 'right' }}>%</th></tr></thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.accountCode}>
                        <td>{r.accountCode} · {r.name}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{money(r.budgetMinor)}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{money(r.actualMinor)}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>
                          <StatusTag tone={varianceTone(r.varianceMinor)} icon={null}>
                            {`${r.varianceMinor > 0 ? '+' : ''}${money(r.varianceMinor)}`}
                          </StatusTag>
                        </td>
                        <td data-numeric style={{ textAlign: 'right' }}>{r.variancePct === null ? '—' : `${r.variancePct > 0 ? '+' : ''}${r.variancePct}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                      <td>Total</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{money(report.totalBudgetMinor)}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{money(report.totalActualMinor)}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{`${totalVariance > 0 ? '+' : ''}${money(totalVariance)}`}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

          <div className="scr__card" data-testid="bva-set" style={{ marginTop: 'var(--sancta-space-4)' }}>
            <h3 className="scr__section-title">Set a budget line — {report.periodId}</h3>
            <div className="scr__row" style={{ alignItems: 'flex-end' }}>
              <Field label="Account code" hint="An existing chart-of-accounts code" data-testid="bva-account"
                value={accountCode} onChange={(e) => setAccountCode(e.currentTarget.value)} style={{ minWidth: 240 }} />
              <Field label="Budget amount" numeric prefix="¢" hint="In cents" data-testid="bva-amount"
                value={amount} min={0} onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))} style={{ maxWidth: 200 }} />
              <Button variant="primary" data-testid="bva-save" disabled={busy}
                {...(!accountCode.trim() ? { disabledReason: 'Enter an account code' } : {})}
                onClick={setBudget}>Save budget</Button>
            </div>
            {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
          </div>
        </div>
      )}
    </section>
  );
}
