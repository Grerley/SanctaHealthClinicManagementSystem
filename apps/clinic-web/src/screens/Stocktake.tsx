import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type StocktakeResult = { lotId: string; bookQty: number; countedQty: number; varianceQty: number; adjustmentValueMinor: number };

/**
 * Physical stocktake with variance approval (INV-008, UAT-11). The blind physical
 * count is compared to the movement-derived BOOK quantity for the lot — the book is
 * never edited directly. A non-zero variance is a CONTROL EVENT: it cannot be
 * applied silently. The screen first asks the hub to compute the variance WITHOUT an
 * approver; if the count matches the book the hub confirms it as balanced, otherwise
 * it rejects the write and returns the variance so it can be shown BEFORE anything is
 * posted. Applying the variance then requires a named approver and a confirmed
 * commit (§9.2) — which posts a linked adjustment movement plus a balanced
 * shrinkage/gain journal. The count is preserved across any failure.
 */
export function Stocktake() {
  const [lotId, setLotId] = useState('');
  const [counted, setCounted] = useState('');
  const [approver, setApprover] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  // The variance surfaced by the compute step, pending an approved apply.
  const [pendingVariance, setPendingVariance] = useState<number | null>(null);
  const [applied, setApplied] = useState<StocktakeResult | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);

  const countedN = Math.floor(Number(counted));
  const countValid = counted.trim() !== '' && Number.isFinite(countedN) && countedN >= 0;
  const canCompute = lotId.trim() !== '' && countValid;

  const reset = () => { setPendingVariance(null); setApplied(null); };

  // Phase 1 — compute the variance without an approver. A balanced count applies as
  // a no-op; a variance is rejected (nothing posted) and surfaced for approval.
  const compute = async () => {
    if (!canCompute) return;
    setBusy(true); setMsg(null); reset();
    const res = await mutate<StocktakeResult>(
      '/api/stock/stocktake',
      { lotId: lotId.trim(), countedQty: countedN },
      { idempotencyKey: newIdempotencyKey() }, // preview — never de-duped against the apply
    );
    setBusy(false);
    if (res.ok && res.data) {
      // Variance was zero: the count equals the book, nothing to approve.
      setApplied(res.data);
      setMsg({ tone: 'success', text: `Count matches the book at ${res.data.bookQty} — no variance, nothing to post.` });
    } else if (res.errorCode === 'stocktake_rejected') {
      const m = res.errorMessage?.match(/variance\s+(-?\d+)/);
      if (m) {
        const v = Number(m[1]);
        setPendingVariance(v);
        setIdemKey(newIdempotencyKey());
        setMsg({ tone: 'warning', text: `The hub computed a variance of ${v > 0 ? '+' : ''}${v} against the book. This will post a ${v < 0 ? 'shrinkage' : 'gain'} adjustment and needs a named approver before it is applied.` });
      } else {
        setMsg({ tone: 'danger', text: `The hub rejected the count${res.errorMessage ? `: ${res.errorMessage}` : ''}. Nothing was posted.` });
      }
    } else if (res.errorCode === 'period_closed') {
      setMsg({ tone: 'danger', text: 'The accounting period is closed — this variance cannot be posted. Nothing was changed.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was posted — your count is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not compute the variance (${res.errorCode ?? 'error'}). Your count is kept.` });
    }
  };

  // Phase 2 — apply the surfaced variance with a named approver (confirmed commit).
  const apply = async () => {
    if (pendingVariance === null || !approver.trim() || !canCompute) return;
    setBusy(true); setMsg(null);
    const res = await mutate<StocktakeResult>(
      '/api/stock/stocktake',
      { lotId: lotId.trim(), countedQty: countedN, approver: approver.trim() },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data) {
      setApplied(res.data); setPendingVariance(null);
      setMsg({ tone: 'success', text: `Stocktake applied — book ${res.data.bookQty} → counted ${res.data.countedQty} (variance ${res.data.varianceQty > 0 ? '+' : ''}${res.data.varianceQty}). A ${res.data.varianceQty < 0 ? 'shrinkage' : 'gain'} of ${money(res.data.adjustmentValueMinor)} was posted with an approval audit event.` });
      setLotId(''); setCounted(''); setApprover(''); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'period_closed') {
      setMsg({ tone: 'danger', text: 'The accounting period is closed — this variance cannot be posted. Your count is kept.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The variance was NOT applied — your count and approver are kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not apply the variance (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your count is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Stocktake">
      <div className="scr__card" data-testid="stk-form">
        <h3 className="scr__section-title">Physical stocktake (INV-008)</h3>
        <p className="scr__kpi-meta">Enter the blind physical count for a lot. The hub compares it to the movement-derived book quantity and shows any variance before anything is posted — the book is never overwritten silently.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Lot id" hint="The batch lot being counted" data-testid="stk-lot" value={lotId} onChange={(e) => { setLotId(e.currentTarget.value); reset(); }} />
          <Field label="Counted quantity" numeric min={0} step={1} hint="Physical units on the shelf" data-testid="stk-counted" value={counted} onChange={(e) => { setCounted(e.currentTarget.value); reset(); }} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant={pendingVariance === null ? 'primary' : 'secondary'} icon={<Icon name="sync" />} data-testid="stk-compute" disabled={busy}
            {...(lotId.trim() === '' ? { disabledReason: 'Enter the lot id' } : !countValid ? { disabledReason: 'Enter a whole counted quantity of zero or more' } : {})}
            onClick={compute}>Compute variance</Button>
        </div>

        {pendingVariance !== null && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }} data-testid="stk-approve-panel">
            <div className="scr__row" style={{ alignItems: 'center' }}>
              <StatusTag tone={pendingVariance === 0 ? 'success' : 'danger'} icon="alert">{`Variance ${pendingVariance > 0 ? '+' : ''}${pendingVariance} — ${pendingVariance < 0 ? 'shrinkage' : 'gain'}`}</StatusTag>
            </div>
            <Banner tone="warning" title="Variance requires an approver">
              Applying this variance posts an adjustment movement and a balanced journal. The clinic hub will reject an apply without a named approver.
            </Banner>
            <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-3)' }}>
              <Field label="Approver" hint="Required — the person accepting the variance" data-testid="stk-approver" value={approver} onChange={(e) => setApprover(e.currentTarget.value)} style={{ minWidth: 260 }} />
              <Button variant="primary" tone="danger" icon={<Icon name="check" />} data-testid="stk-apply" disabled={busy}
                {...(!approver.trim() ? { disabledReason: 'A named approver must accept this variance' } : {})}
                onClick={apply}>Apply variance</Button>
              <Button variant="subtle" data-testid="stk-cancel" disabled={busy} onClick={() => { reset(); setMsg(null); }}>Cancel</Button>
            </div>
          </div>
        )}

        {applied && (
          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <table className="scr__table" data-testid="stk-result">
              <caption className="sancta-visually-hidden">Computed stocktake result for the lot</caption>
              <thead><tr><th scope="col">Book</th><th scope="col">Counted</th><th scope="col">Variance</th><th scope="col" style={{ textAlign: 'right' }}>Adjustment value</th></tr></thead>
              <tbody>
                <tr>
                  <td data-numeric>{applied.bookQty}</td>
                  <td data-numeric>{applied.countedQty}</td>
                  <td data-numeric>{applied.varianceQty > 0 ? '+' : ''}{applied.varianceQty}</td>
                  <td data-numeric style={{ textAlign: 'right' }}>{money(applied.adjustmentValueMinor)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
