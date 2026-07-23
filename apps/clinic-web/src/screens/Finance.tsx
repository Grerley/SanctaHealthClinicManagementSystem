import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, money, type AgeingReport, type TrialBalance, type AgeingBand, type DebtorRow } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type View = 'debtors' | 'trial-balance';
type Method = 'cash' | 'bank' | 'mobile';
const BANDS: AgeingBand[] = ['0-30', '31-60', '61-90', '90+'];
const BAND_TONE: Record<AgeingBand, 'neutral' | 'warning' | 'danger'> = { '0-30': 'neutral', '31-60': 'warning', '61-90': 'warning', '90+': 'danger' };

/**
 * Finance workspace — debtor ageing (BIL-07) + trial balance (FIN-08) + record
 * payment (BIL-04). Every figure is derived from the immutable ledger, never a
 * stored/editable total (§3.2); the debtor total is reconciled to the AR control
 * account and a divergence is shown, not hidden. Recording a payment uses the §9.2
 * mutation contract: an idempotency key per intent so a retry never double-posts
 * (safety #8), success shown only on a confirmed commit, and the draft kept on
 * failure.
 */
export function Finance() {
  const [view, setView] = useState<View>('debtors');
  const [ageing, setAgeing] = useState<AgeingReport | null>(null);
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Payment draft (§9.2 draft state — preserved across a failed commit).
  const [target, setTarget] = useState<DebtorRow | null>(null);
  const [amount, setAmount] = useState<number>(0);
  const [method, setMethod] = useState<Method>('cash');
  const [idemKey, setIdemKey] = useState<string>(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [payMsg, setPayMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [a, t] = await Promise.all([api.debtorsAgeing(), api.trialBalance()]);
    setAgeing(a); setTb(t);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => {
      try { await load(); setState('ready'); } catch { setState('error'); }
    })();
  }, [load]);

  // Selecting a different debtor starts a NEW payment intent (fresh idempotency key).
  const chooseDebtor = (d: DebtorRow) => {
    setTarget(d);
    setAmount(Math.round(d.outstandingMinor));
    setIdemKey(newIdempotencyKey());
    setPayMsg(null);
  };

  const recordPayment = async () => {
    if (!target || amount <= 0) return;
    setBusy(true);
    setPayMsg(null);
    // The SAME idempotency key is reused on retry of this intent, so a double
    // submit or a queue replay records the payment exactly once (§8).
    const res = await mutate<{ paymentId: string; duplicate?: boolean }>(
      '/api/billing/payment',
      { patientId: target.patientId, method, amountMinor: amount },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.duplicate) {
      setPayMsg({ tone: 'warning', text: 'Already recorded — this payment was not taken twice.' });
    } else if (res.ok) {
      setPayMsg({ tone: 'success', text: `Payment of ${money(amount)} recorded and saved to the clinic. Receipt ···${res.data?.paymentId?.slice(-8) ?? ''}.` });
      // Committed: this intent is done — a further click is a NEW intent.
      setTarget(null); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setPayMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was posted — your entry is kept; retry when connected.' });
    } else {
      setPayMsg({ tone: 'danger', text: `Payment blocked (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

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
                  <caption className="sancta-visually-hidden">Patients with an outstanding balance, oldest band first. Select a row to record a payment.</caption>
                  <thead><tr><th scope="col">Patient</th><th scope="col">Clinic no.</th><th scope="col">Oldest</th><th scope="col" style={{ textAlign: 'right' }}>Outstanding</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {ageing.workQueue.map((d) => (
                      <tr key={d.patientId} data-selected={target?.patientId === d.patientId || undefined}>
                        <td>{d.name}</td>
                        <td data-numeric>{d.mrn ?? '—'}</td>
                        <td><StatusTag tone={BAND_TONE[d.oldestBand]}>{d.oldestBand}</StatusTag></td>
                        <td data-numeric style={{ textAlign: 'right' }}>{money(d.outstandingMinor)}</td>
                        <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid="fin-pay" onClick={() => chooseDebtor(d)}>Record payment</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          {target && (
            <div className="scr__card" data-testid="fin-payment-panel" style={{ marginTop: 'var(--sancta-space-4)' }}>
              <h3 className="scr__section-title">Record payment — {target.name}</h3>
              <div className="scr__row" style={{ alignItems: 'flex-end' }}>
                <Field label="Amount" numeric prefix="¢" hint="In cents" data-testid="fin-pay-amount" value={amount} min={1} onChange={(e) => setAmount(Number(e.currentTarget.value))} style={{ maxWidth: 180 }} />
                <label className="sancta-field" style={{ maxWidth: 160 }}>
                  <span className="sancta-field__label">Method</span>
                  <select className="sancta-field-input" data-testid="fin-pay-method" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                    <option value="cash">Cash</option><option value="bank">Bank</option><option value="mobile">Mobile</option>
                  </select>
                </label>
                <Button variant="primary" data-testid="fin-pay-submit" disabled={busy}
                  {...(amount <= 0 ? { disabledReason: 'Enter a positive amount' } : {})}
                  onClick={recordPayment}>Take payment</Button>
                <Button variant="subtle" data-testid="fin-pay-cancel" disabled={busy} onClick={() => { setTarget(null); setPayMsg(null); }}>Cancel</Button>
              </div>
              {payMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={payMsg.tone} assertive={payMsg.tone === 'danger'}>{payMsg.text}</Banner></div>}
            </div>
          )}
          {!target && payMsg && <div data-testid="fin-pay-result"><Banner tone={payMsg.tone}>{payMsg.text}</Banner></div>}
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
