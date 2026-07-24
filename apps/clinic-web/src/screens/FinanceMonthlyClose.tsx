import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';

/**
 * Period close (FIN-009). Run a monthly close for an accounting period, or reopen a
 * closed period. Reopening is a controlled action carrying a mandatory reason. Both are
 * confirmed-commit writes (§9.2); the entry is preserved on failure.
 */
export function FinanceMonthlyClose() {
  const [periodId, setPeriodId] = useState('');
  const [closeIdem, setCloseIdem] = useState(newIdempotencyKey());
  const [closing, setClosing] = useState(false);
  const [closeMsg, setCloseMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [reopenPeriodId, setReopenPeriodId] = useState('');
  const [reason, setReason] = useState('');
  const [reopenIdem, setReopenIdem] = useState(newIdempotencyKey());
  const [reopening, setReopening] = useState(false);
  const [reopenMsg, setReopenMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const runClose = async () => {
    if (periodId.trim() === '') return;
    setClosing(true); setCloseMsg(null);
    const res = await mutate<{ periodId: string; status: string }>(
      '/api/finance/monthly-close',
      { periodId: periodId.trim(), approver: BY },
      { idempotencyKey: closeIdem },
    );
    setClosing(false);
    if (res.ok) { setCloseMsg({ tone: 'success', text: `Closed period ${periodId.trim()}.` }); setCloseIdem(newIdempotencyKey()); }
    else if (res.errorCode === 'network') setCloseMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected.' });
    else setCloseMsg({ tone: 'danger', text: `Could not close the period (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}).` });
  };

  const runReopen = async () => {
    if (reopenPeriodId.trim() === '' || reason.trim() === '') return;
    setReopening(true); setReopenMsg(null);
    const res = await mutate<{ periodId: string; status: string }>(
      '/api/finance/period/reopen',
      { periodId: reopenPeriodId.trim(), approver: BY, reason: reason.trim() },
      { idempotencyKey: reopenIdem },
    );
    setReopening(false);
    if (res.ok) { setReopenMsg({ tone: 'success', text: `Reopened period ${reopenPeriodId.trim()}.` }); setReason(''); setReopenIdem(newIdempotencyKey()); }
    else if (res.errorCode === 'network') setReopenMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected.' });
    else setReopenMsg({ tone: 'danger', text: `Could not reopen the period (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}).` });
  };

  return (
    <section className="scr" aria-label="Period close">
      <div className="scr__card" data-testid="monthly-close-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Monthly close</h3>
          <StatusTag tone="info" icon="info">Locks the period</StatusTag>
        </div>
        <p className="scr__kpi-meta">Running the close finalises the period. Enter the period identifier, e.g. 2026-07.</p>
        <div className="scr__toolbar" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Period id" hint="e.g. 2026-07" data-testid="monthly-close-period" value={periodId} onChange={(e) => setPeriodId(e.currentTarget.value)} />
          <Button variant="primary" icon={<Icon name="check" />} data-testid="monthly-close-submit" disabled={closing}
            {...(periodId.trim() === '' ? { disabledReason: 'Enter the period id' } : {})} onClick={runClose}>Run close</Button>
        </div>
        {closeMsg && <Banner tone={closeMsg.tone} assertive={closeMsg.tone === 'danger'}>{closeMsg.text}</Banner>}
      </div>

      <div className="scr__card" data-testid="reopen-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Reopen a period</h3>
          <StatusTag tone="danger" icon="alert">Controlled action</StatusTag>
        </div>
        <p className="scr__kpi-meta">Reopening a closed period is exceptional and requires a reason for the audit trail.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Period id" hint="The closed period" data-testid="reopen-period" value={reopenPeriodId} onChange={(e) => setReopenPeriodId(e.currentTarget.value)} />
          <Field label="Reason" hint="Why it must be reopened" data-testid="reopen-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" tone="danger" icon={<Icon name="alert" />} data-testid="reopen-submit" disabled={reopening}
            {...(reopenPeriodId.trim() === '' ? { disabledReason: 'Enter the period id' } : reason.trim() === '' ? { disabledReason: 'Enter a reason' } : {})}
            onClick={runReopen}>Reopen period</Button>
        </div>
        {reopenMsg && <Banner tone={reopenMsg.tone} assertive={reopenMsg.tone === 'danger'}>{reopenMsg.text}</Banner>}
      </div>
    </section>
  );
}
