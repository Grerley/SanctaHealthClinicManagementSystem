import { useState } from 'react';
import { Banner, Button, Field, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const USER = 'demo-operator';

/**
 * Result correction and order cancellation without deletion (ORD-009). A released
 * result is never silently overwritten: a correction supersedes the original with a
 * new value while the original is RETAINED and marked corrected, and a reason is
 * mandatory and audited. Likewise an order is cancelled — not deleted — with a
 * required reason. Both are confirmed-commit writes (§9.2): success shows only once
 * the hub accepts, and the draft is preserved on any failure. Because a reason is
 * required on both, nothing is amended without an audit trail.
 */
export function ResultCorrection() {
  // Correction draft.
  const [resultId, setResultId] = useState('');
  const [newValue, setNewValue] = useState('');
  const [corrReason, setCorrReason] = useState('');
  const [corrIdem, setCorrIdem] = useState(newIdempotencyKey());
  const [correcting, setCorrecting] = useState(false);
  const [corrMsg, setCorrMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Cancel draft.
  const [orderId, setOrderId] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelIdem, setCancelIdem] = useState(newIdempotencyKey());
  const [cancelling, setCancelling] = useState(false);
  const [cancelMsg, setCancelMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const newValueNum = newValue.trim() === '' ? null : Number(newValue);
  const newValueInvalid = newValue.trim() !== '' && Number.isNaN(newValueNum);
  const canCorrect = resultId.trim().length > 0 && newValueNum !== null && !newValueInvalid && corrReason.trim().length > 0;

  const correct = async () => {
    if (!canCorrect || newValueNum === null) return;
    setCorrecting(true); setCorrMsg(null);
    const res = await mutate<{ correctedResultId: string }>(
      '/api/orders/result/correct',
      { resultId: resultId.trim(), newValue: newValueNum, reason: corrReason.trim(), by: USER },
      { idempotencyKey: corrIdem },
    );
    setCorrecting(false);
    if (res.ok && res.data?.correctedResultId) {
      setCorrMsg({ tone: 'success', text: `Correction recorded (new result ···${res.data.correctedResultId.slice(-8)}). The original is retained and marked corrected.` });
      setResultId(''); setNewValue(''); setCorrReason(''); setCorrIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setCorrMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setCorrMsg({ tone: 'danger', text: `Could not correct the result (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const canCancel = orderId.trim().length > 0 && cancelReason.trim().length > 0;

  const cancel = async () => {
    if (!canCancel) return;
    setCancelling(true); setCancelMsg(null);
    const res = await mutate<{ orderId: string; status: 'cancelled' }>(
      '/api/orders/cancel',
      { orderId: orderId.trim(), reason: cancelReason.trim(), by: USER },
      { idempotencyKey: cancelIdem },
    );
    setCancelling(false);
    if (res.ok && res.data?.status) {
      setCancelMsg({ tone: 'success', text: `Order ···${orderId.trim().slice(-8)} cancelled. It is retained, not deleted, and the reason is on the audit trail.` });
      setOrderId(''); setCancelReason(''); setCancelIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setCancelMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setCancelMsg({ tone: 'danger', text: `Could not cancel the order (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Result correction and order cancellation">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Corrections & cancellations (ORD-009)</h3>
        <StatusTag tone="info" icon="lock">Nothing deleted — every change is audited</StatusTag>
      </div>

      <div className="scr__card" data-testid="rc-correct-form">
        <h3 className="scr__section-title">Correct a released result</h3>
        <p className="scr__kpi-meta">A correction never overwrites the original silently. The original result is retained and marked corrected; the new value supersedes it. A reason is required for the audit trail.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Result id" hint="The released result to correct" data-testid="rc-result-id" value={resultId} onChange={(e) => setResultId(e.currentTarget.value)} />
          <Field label="Corrected value" numeric hint="The new, correct numeric value" data-testid="rc-new-value" value={newValue} onChange={(e) => setNewValue(e.currentTarget.value)}
            {...(newValueInvalid ? { error: 'Enter a number' } : {})} />
          <Field label="Reason" hint="Required — why the result is being corrected" data-testid="rc-reason" value={corrReason} onChange={(e) => setCorrReason(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="rc-correct-submit" disabled={correcting}
            {...(!canCorrect ? { disabledReason: 'Enter the result id, a numeric corrected value and a reason' } : {})}
            onClick={correct}>Record correction</Button>
        </div>
        {corrMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={corrMsg.tone} assertive={corrMsg.tone === 'danger'}>{corrMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="rc-cancel-form">
        <h3 className="scr__section-title">Cancel an order</h3>
        <p className="scr__kpi-meta">Cancelling an order retains it — it is never deleted. A completed or already-cancelled order cannot be cancelled. A reason is required and audited.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Order id" hint="The order to cancel" data-testid="rc-order-id" value={orderId} onChange={(e) => setOrderId(e.currentTarget.value)} />
          <Field label="Reason" hint="Required — why the order is being cancelled" data-testid="rc-cancel-reason" value={cancelReason} onChange={(e) => setCancelReason(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone="danger" data-testid="rc-cancel-submit" disabled={cancelling}
            {...(!canCancel ? { disabledReason: 'Enter the order id and a reason' } : {})}
            onClick={cancel}>Cancel order</Button>
        </div>
        {cancelMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={cancelMsg.tone} assertive={cancelMsg.tone === 'danger'}>{cancelMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
