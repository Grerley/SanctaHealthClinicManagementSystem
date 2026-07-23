import { useEffect, useState } from 'react';
import { Banner, StatusTag, StateBlock } from '@sancta/ui';
import { api, money, type AgeingReport, type TrialBalance, type AgeingBand } from '../api.ts';
import './screens.css';

type View = 'debtors' | 'trial-balance';
const BANDS: AgeingBand[] = ['0-30', '31-60', '61-90', '90+'];
const BAND_TONE: Record<AgeingBand, 'neutral' | 'warning' | 'danger'> = { '0-30': 'neutral', '31-60': 'warning', '61-90': 'warning', '90+': 'danger' };

/**
 * Finance workspace — debtor ageing (BIL-07) + trial balance (FIN-08). Every figure
 * is derived from the immutable ledger, never a stored/editable total (§3.2); the
 * debtor total is reconciled to the AR control account and a divergence is shown,
 * not hidden. Money uses tabular figures with a permanent currency context.
 */
export function Finance() {
  const [view, setView] = useState<View>('debtors');
  const [ageing, setAgeing] = useState<AgeingReport | null>(null);
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setState('loading');
    void (async () => {
      try {
        const [a, t] = await Promise.all([api.debtorsAgeing(), api.trialBalance()]);
        setAgeing(a); setTb(t); setState('ready');
      } catch { setState('error'); }
    })();
  }, []);

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading finance data" />;
  if (state === 'error') return <StateBlock state="stale" title="Finance data unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Finance workspace">
      <div className="scr__seg" role="tablist" aria-label="Finance view">
        <button role="tab" aria-selected={view === 'debtors'} data-testid="fin-view-debtors" className="scr__seg-btn sancta-focusable" data-active={view === 'debtors'} onClick={() => setView('debtors')}>Debtors (BIL-07)</button>
        <button role="tab" aria-selected={view === 'trial-balance'} data-testid="fin-view-tb" className="scr__seg-btn sancta-focusable" data-active={view === 'trial-balance'} onClick={() => setView('trial-balance')}>Trial balance (FIN-08)</button>
      </div>

      {view === 'debtors' && ageing && (
        <div data-testid="fin-debtors">
          {ageing.reconciles
            ? <Banner tone="success" title="Debtors reconcile to the ledger">Ageing total {money(ageing.totalMinor)} equals the AR control account.</Banner>
            : <Banner tone="danger" title="Debtors do NOT reconcile to the ledger" assertive>Ageing total {money(ageing.totalMinor)} vs AR control {money(ageing.arControlMinor)} — investigate before reporting.</Banner>}

          <div className="scr__kpi-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
            {BANDS.map((b) => (
              <div key={b} className="scr__kpi">
                <span className="scr__kpi-label">{b} days</span>
                <span className="scr__kpi-value">{money(ageing.buckets[b])}</span>
                <span className="scr__kpi-meta"><StatusTag tone={BAND_TONE[b]}>{b === '90+' ? 'Oldest' : 'Current'}</StatusTag></span>
              </div>
            ))}
          </div>

          <h3 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-4)' }}>Collection work queue</h3>
          {ageing.workQueue.length === 0
            ? <StateBlock state="empty" title="No outstanding debtors" />
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="fin-debtor-queue">
                  <caption className="sancta-visually-hidden">Patients with an outstanding balance, oldest band first</caption>
                  <thead><tr><th scope="col">Patient</th><th scope="col">Clinic no.</th><th scope="col">Oldest</th><th scope="col" style={{ textAlign: 'right' }}>Outstanding</th></tr></thead>
                  <tbody>
                    {ageing.workQueue.map((d) => (
                      <tr key={d.patientId}>
                        <td>{d.name}</td>
                        <td data-numeric>{d.mrn ?? '—'}</td>
                        <td><StatusTag tone={BAND_TONE[d.oldestBand]}>{d.oldestBand}</StatusTag></td>
                        <td data-numeric style={{ textAlign: 'right' }}>{money(d.outstandingMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      {view === 'trial-balance' && tb && (
        <div data-testid="fin-tb">
          {tb.balanced
            ? <Banner tone="success" title="Trial balance is balanced">Total debits equal total credits ({money(tb.totalDebitMinor)}).</Banner>
            : <Banner tone="danger" title="Trial balance is OUT of balance" assertive>Debits {money(tb.totalDebitMinor)} ≠ credits {money(tb.totalCreditMinor)}.</Banner>}
          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <table className="scr__table">
              <caption className="sancta-visually-hidden">Trial balance by account</caption>
              <thead><tr><th scope="col">Account</th><th scope="col">Type</th><th scope="col" style={{ textAlign: 'right' }}>Debit</th><th scope="col" style={{ textAlign: 'right' }}>Credit</th></tr></thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.code}>
                    <td>{r.code} · {r.name}</td>
                    <td>{r.type}</td>
                    <td data-numeric style={{ textAlign: 'right' }}>{r.debitMinor ? money(r.debitMinor) : ''}</td>
                    <td data-numeric style={{ textAlign: 'right' }}>{r.creditMinor ? money(r.creditMinor) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                  <td colSpan={2}>Total</td>
                  <td data-numeric style={{ textAlign: 'right' }}>{money(tb.totalDebitMinor)}</td>
                  <td data-numeric style={{ textAlign: 'right' }}>{money(tb.totalCreditMinor)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
