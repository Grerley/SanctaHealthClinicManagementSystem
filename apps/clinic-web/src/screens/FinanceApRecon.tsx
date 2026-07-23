import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type ApRecon = { subledgerMinor: number; controlMinor: number; reconciles: boolean };
type PayMethod = 'cash' | 'bank';

/**
 * Accounts-payable reconciliation (FIN-005/006). The AP subledger (open payables)
 * must tie out to the GL supplier-AP control account; the read returns both totals
 * and a reconciliation flag, safe to load on mount and re-query. Paying a supplier
 * posts Dr AP / Cr cash-or-bank and settles the payable — a §9.2 confirmed-commit
 * write (idempotency key per intent, draft kept on failure). Because it moves cash
 * it never reports success before the hub durably commits; the reconciliation is
 * reloaded afterwards so the operator sees the subledger and control move together.
 */
export function FinanceApRecon() {
  const [recon, setRecon] = useState<ApRecon | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [payableId, setPayableId] = useState('');
  const [method, setMethod] = useState<PayMethod>('cash');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const r = await jsonFetch<ApRecon>('/api/finance/ap-reconciliation');
      setRecon(r); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const pay = async () => {
    if (payableId.trim() === '') return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ paidMinor: number }>(
      '/api/finance/pay-supplier',
      { payableId: payableId.trim(), method },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok && res.data) {
      setMsg({ tone: 'success', text: `Supplier paid $${money(res.data.paidMinor)} by ${method}. The payable is settled.` });
      setPayableId(''); setIdem(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else if (res.errorCode === 'payable_rejected') {
      setMsg({ tone: 'danger', text: `Payment blocked (${res.errorMessage ?? 'the payable is unknown or already settled'}). Your entry is kept.` });
    } else {
      setMsg({ tone: 'danger', text: `Could not pay the supplier (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const varianceMinor = recon ? recon.subledgerMinor - recon.controlMinor : 0;

  return (
    <section className="scr" aria-label="AP reconciliation">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">AP subledger vs control (FIN-006)</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="ap-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          {recon && <StatusTag tone={recon.reconciles ? 'success' : 'danger'} icon={recon.reconciles ? 'check' : 'alert'}>{recon.reconciles ? 'Reconciled' : `Out by $${money(Math.abs(varianceMinor))}`}</StatusTag>}
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading AP reconciliation" />}
        {state === 'error' && <StateBlock state="stale" title="AP reconciliation unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && recon && (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="ap-recon">
              <caption className="sancta-visually-hidden">Accounts-payable subledger open balance against the general-ledger control account</caption>
              <thead><tr><th scope="col">Measure</th><th scope="col" style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                <tr><td>Subledger (open payables)</td><td data-numeric style={{ textAlign: 'right' }} data-testid="ap-subledger">{`$${money(recon.subledgerMinor)}`}</td></tr>
                <tr><td>GL control (supplier AP)</td><td data-numeric style={{ textAlign: 'right' }} data-testid="ap-control">{`$${money(recon.controlMinor)}`}</td></tr>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                  <td>Variance</td><td data-numeric style={{ textAlign: 'right' }} data-testid="ap-variance">{`$${money(varianceMinor)}`}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="scr__card" data-testid="ap-pay-form">
        <h3 className="scr__section-title">Pay a supplier</h3>
        <p className="scr__kpi-meta">Settling a payable posts Dr supplier AP / Cr cash-or-bank and marks it paid. Enter the payable id and choose how it was paid.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Payable id" hint="The open payable to settle" data-testid="ap-payable-id" value={payableId} onChange={(e) => setPayableId(e.currentTarget.value)} />
          <label className="sancta-field">
            <span className="sancta-field__label">Payment method</span>
            <select className="sancta-field-input" data-testid="ap-method" value={method} onChange={(e) => setMethod(e.currentTarget.value === 'bank' ? 'bank' : 'cash')}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </select>
          </label>
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="ap-pay-submit" disabled={busy}
            {...(payableId.trim() === '' ? { disabledReason: 'Enter the payable id' } : {})}
            onClick={pay}>Pay supplier</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
