import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, money, type OpenShift, type CloseShiftResult } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

// Tolerance below which a variance closes without supervisor sign-off (BIL-009).
// A larger discrepancy is a control event: it MUST be approved by name, and the
// server enforces this authoritatively (409 shift_approval_required).
const TOLERANCE_MINOR = 100; // $1.00

// The drawer denominations counted at close, largest first. Minor units (cents).
const DENOMS: Array<{ unitMinor: number; label: string }> = [
  { unitMinor: 10000, label: '$100' },
  { unitMinor: 5000, label: '$50' },
  { unitMinor: 2000, label: '$20' },
  { unitMinor: 1000, label: '$10' },
  { unitMinor: 500, label: '$5' },
  { unitMinor: 100, label: '$1' },
  { unitMinor: 25, label: '25¢' },
  { unitMinor: 10, label: '10¢' },
  { unitMinor: 5, label: '5¢' },
  { unitMinor: 1, label: '1¢' },
];

type Counts = Record<number, number>;
const emptyCounts = (): Counts => Object.fromEntries(DENOMS.map((d) => [d.unitMinor, 0]));

/**
 * Cashier shift close (BIL-06 / BIL-009, UAT-09). The drawer's EXPECTED cash is
 * derived live from the immutable cash payments plus the opening float — never a
 * stored total (§3.2). The cashier physically counts the drawer by denomination;
 * the counted total and the variance are computed in front of them. A variance
 * within tolerance closes and posts a cash-over/short journal; a variance ABOVE
 * tolerance cannot close without a named supervisor — the UI requires the approver
 * and the server rejects an un-approved over-tolerance close (409). Closing is a
 * confirmed-commit write (§9.2): the count is never lost, and the shift only shows
 * closed once the hub durably accepts it. Closes safety scenario #10.
 */
export function Cashier() {
  const [shifts, setShifts] = useState<OpenShift[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Close draft (§9.2 — the physical count is preserved across a failed commit).
  const [target, setTarget] = useState<OpenShift | null>(null);
  const [counts, setCounts] = useState<Counts>(emptyCounts());
  const [approver, setApprover] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [closeMsg, setCloseMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api.openShifts();
    setShifts(r.shifts);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => {
      try { await load(); setState('ready'); } catch { setState('error'); }
    })();
  }, [load]);

  // Selecting a shift starts a fresh close intent (new idempotency key, zeroed count).
  const beginClose = (s: OpenShift) => {
    setTarget(s); setCounts(emptyCounts()); setApprover(''); setIdemKey(newIdempotencyKey()); setCloseMsg(null);
  };

  const countedMinor = DENOMS.reduce((sum, d) => sum + d.unitMinor * (counts[d.unitMinor] ?? 0), 0);
  const varianceMinor = target ? countedMinor - target.expectedMinor : 0;
  const overTolerance = Math.abs(varianceMinor) > TOLERANCE_MINOR;
  const needsApprover = overTolerance && !approver.trim();

  const closeShift = async () => {
    if (!target || needsApprover) return;
    setBusy(true); setCloseMsg(null);
    const denominations = DENOMS
      .filter((d) => (counts[d.unitMinor] ?? 0) > 0)
      .map((d) => ({ unitMinor: d.unitMinor, count: counts[d.unitMinor] ?? 0 }));
    const res = await mutate<CloseShiftResult>(
      '/api/cashier/close',
      {
        shiftId: target.shiftId,
        denominations,
        toleranceMinor: TOLERANCE_MINOR,
        ...(approver.trim() ? { approver: approver.trim() } : {}),
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data) {
      const v = res.data.varianceMinor;
      const varianceText = v === 0 ? 'balanced exactly' : `${v < 0 ? 'short' : 'over'} by ${money(Math.abs(v))}`;
      setCloseMsg({
        tone: v === 0 ? 'success' : 'warning',
        text: `Shift closed — counted ${money(res.data.countedMinor)} against expected ${money(res.data.expectedMinor)} (${varianceText}).${res.data.approved ? ' Supervisor approval recorded.' : ''}${v !== 0 ? ' A cash-over/short entry was posted to the ledger.' : ''}`,
      });
      setTarget(null); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'shift_approval_required') {
      setCloseMsg({ tone: 'danger', text: 'This variance is above tolerance and needs a supervisor to approve by name. The shift was NOT closed — your count is kept; add an approver and try again.' });
    } else if (res.errorCode === 'network') {
      setCloseMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The shift was NOT closed — your count is kept; retry when connected.' });
    } else {
      setCloseMsg({ tone: 'danger', text: `Could not close the shift (${res.errorCode ?? 'error'}). Your count is kept.` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading open shifts" />;
  if (state === 'error') return <StateBlock state="stale" title="Shifts unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Cashier shift close">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Open shifts (BIL-06)</h3>
          <StatusTag tone={shifts.length > 0 ? 'neutral' : 'success'} icon={shifts.length > 0 ? null : 'check'}>
            {shifts.length > 0 ? `${shifts.length} open` : 'All reconciled'}
          </StatusTag>
        </div>
        {shifts.length === 0
          ? <StateBlock state="empty" title="No open shifts">Every cashier drawer has been counted and closed.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="cash-shifts">
                <caption className="sancta-visually-hidden">Open cashier shifts with the expected drawer total. Select close to count and reconcile.</caption>
                <thead><tr><th scope="col">Cashier</th><th scope="col">Opened</th><th scope="col" style={{ textAlign: 'right' }}>Float</th><th scope="col" style={{ textAlign: 'right' }}>Cash taken</th><th scope="col" style={{ textAlign: 'right' }}>Expected</th><th scope="col"></th></tr></thead>
                <tbody>
                  {shifts.map((s) => (
                    <tr key={s.shiftId} data-selected={target?.shiftId === s.shiftId || undefined}>
                      <td>{s.cashier}</td>
                      <td data-numeric>{s.openedAt.slice(0, 16).replace('T', ' ')}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{money(s.openingFloatMinor)}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{money(s.cashReceiptsMinor)} <span className="scr__kpi-meta">({s.paymentCount})</span></td>
                      <td data-numeric style={{ textAlign: 'right' }}><strong>{money(s.expectedMinor)}</strong></td>
                      <td style={{ textAlign: 'right' }}><Button variant="primary" density="compact" data-testid="cash-close" onClick={() => beginClose(s)}>Count & close</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {target && (
        <div className="scr__card" data-testid="cash-close-panel">
          <h3 className="scr__section-title">Count drawer — {target.cashier}</h3>
          <p className="scr__kpi-meta">Count the physical cash by denomination. The expected total is {money(target.expectedMinor)} (float {money(target.openingFloatMinor)} + cash taken {money(target.cashReceiptsMinor)}), derived from the sealed payment record (§3.2).</p>

          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <table className="scr__table" data-testid="cash-denoms">
              <caption className="sancta-visually-hidden">Physical denomination count</caption>
              <thead><tr><th scope="col">Denomination</th><th scope="col" style={{ textAlign: 'right' }}>Count</th><th scope="col" style={{ textAlign: 'right' }}>Subtotal</th></tr></thead>
              <tbody>
                {DENOMS.map((d) => (
                  <tr key={d.unitMinor}>
                    <td>{d.label}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Field label={`Count of ${d.label}`} hideLabel numeric min={0} step={1} data-testid={`cash-denom-${d.unitMinor}`}
                        value={counts[d.unitMinor] ?? 0}
                        onChange={(e) => { const n = Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)); setCounts((c) => ({ ...c, [d.unitMinor]: n })); }}
                        style={{ maxWidth: 96, marginInlineStart: 'auto' }} />
                    </td>
                    <td data-numeric style={{ textAlign: 'right' }}>{money(d.unitMinor * (counts[d.unitMinor] ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                  <td>Counted</td>
                  <td></td>
                  <td data-numeric style={{ textAlign: 'right' }} data-testid="cash-counted">{money(countedMinor)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <StatusTag tone={varianceMinor === 0 ? 'success' : overTolerance ? 'danger' : 'warning'} icon={varianceMinor === 0 ? 'check' : 'alert'}>
              {varianceMinor === 0 ? 'Balances exactly' : `${varianceMinor < 0 ? 'Short' : 'Over'} by ${money(Math.abs(varianceMinor))}`}
            </StatusTag>
            <span className="scr__kpi-meta" data-testid="cash-variance">
              Tolerance {money(TOLERANCE_MINOR)}. {overTolerance ? 'Above tolerance — supervisor approval required.' : 'Within tolerance.'}
            </span>
          </div>

          {overTolerance && (
            <div style={{ marginTop: 'var(--sancta-space-2)' }}>
              <Banner tone="warning" title="Variance is above tolerance">
                A supervisor must approve this close by name. The clinic hub will reject an over-tolerance close without one.
              </Banner>
            </div>
          )}

          <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-3)' }}>
            <Field label="Supervisor approver" optional={!overTolerance} hint={overTolerance ? 'Required — the supervisor accepting the variance' : 'Only needed above tolerance'}
              data-testid="cash-approver" value={approver} onChange={(e) => setApprover(e.currentTarget.value)} style={{ minWidth: 260 }} />
            <Button variant="primary" data-testid="cash-close-submit" disabled={busy}
              {...(needsApprover ? { disabledReason: 'A supervisor must approve this over-tolerance variance by name' } : {})}
              onClick={closeShift}>Close shift &amp; reconcile</Button>
            <Button variant="subtle" data-testid="cash-close-cancel" disabled={busy} onClick={() => { setTarget(null); setCloseMsg(null); }}>Cancel</Button>
          </div>
          {closeMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={closeMsg.tone} assertive={closeMsg.tone === 'danger'}>{closeMsg.text}</Banner></div>}
        </div>
      )}
      {!target && closeMsg && <div data-testid="cash-close-result"><Banner tone={closeMsg.tone}>{closeMsg.text}</Banner></div>}
    </section>
  );
}
