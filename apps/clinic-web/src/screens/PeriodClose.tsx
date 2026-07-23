import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type PeriodState = { periodId: string; status: string | null };

/**
 * Period open / close (FIN-004, BR-010/011). Closing or reopening a financial
 * period is an approve-gated control event: it MUST be authorised by a named
 * approver, and reopening a hard-closed period additionally requires a reason for
 * the audit trail. Once closed, no journal can post into the period — so this gate
 * protects every downstream report. Reads by period id (a year-month string) are
 * safe; the close/reopen writes use the §9.2 confirmed-commit contract with a fresh
 * idempotency key per intent, and the server authoritatively enforces the approve
 * permission (a 403 is surfaced, never silently succeeded).
 */
export function PeriodClose() {
  const [periodId, setPeriodId] = useState('');
  const [current, setCurrent] = useState<PeriodState | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [approver, setApprover] = useState('');
  const [reason, setReason] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const canLoad = /^\d{4}-\d{2}$/.test(periodId.trim());

  const load = async () => {
    if (!canLoad) return;
    setState('loading'); setMsg(null);
    try {
      const r = await jsonFetch<PeriodState>(`/api/finance/period?id=${encodeURIComponent(periodId.trim())}`);
      setCurrent(r); setState('ready'); setIdemKey(newIdempotencyKey());
    } catch { setState('error'); }
  };

  const isClosed = current?.status === 'hard_close';
  const needsApprover = !approver.trim();
  const needsReason = isClosed && !reason.trim(); // reopen requires a reason

  const submit = async (action: 'close' | 'reopen') => {
    if (!current || needsApprover) return;
    if (action === 'reopen' && !reason.trim()) return;
    setBusy(true); setMsg(null);
    const body = action === 'close'
      ? { periodId: current.periodId, approver: approver.trim() }
      : { periodId: current.periodId, approver: approver.trim(), reason: reason.trim() };
    const res = await mutate<{ periodId: string; status: string }>(`/api/finance/period/${action}`, body, { idempotencyKey: idemKey });
    setBusy(false);
    if (res.ok && res.data) {
      setMsg({ tone: 'success', text: action === 'close'
        ? `Period ${res.data.periodId} closed. No further journals can post into it; the close is recorded against ${approver.trim()}.`
        : `Period ${res.data.periodId} reopened by ${approver.trim()}. Reason logged: "${reason.trim()}".` });
      setCurrent({ periodId: res.data.periodId, status: res.data.status });
      setReason(''); setIdemKey(newIdempotencyKey());
    } else if (res.status === 403) {
      setMsg({ tone: 'danger', text: 'You do not have permission to approve a period change — a finance approver is required. Nothing was changed.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was changed — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Period change blocked (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Period open and close">
      <div className="scr__row" style={{ alignItems: 'flex-end' }}>
        <Field label="Financial period" hint="Year-month, e.g. 2026-07" data-testid="pc-period" value={periodId}
          onChange={(e) => setPeriodId(e.currentTarget.value)} style={{ maxWidth: 220 }} />
        <Button variant="primary" data-testid="pc-load"
          {...(canLoad ? {} : { disabledReason: 'Enter a period as year-month (e.g. 2026-07)' })}
          onClick={load}>Load period</Button>
      </div>

      {state === 'loading' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="initial-loading" title="Loading period status" /></div>}
      {state === 'error' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="stale" title="Period status unavailable">The clinic hub may be unreachable.</StateBlock></div>}
      {state === 'idle' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="empty" title="Enter a period to view its status">Closing a period seals it against further postings.</StateBlock></div>}

      {state === 'ready' && current && (
        <div className="scr__card" data-testid="pc-panel" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
            <h3 className="scr__section-title">Period {current.periodId}</h3>
            <StatusTag tone={isClosed ? 'neutral' : 'success'} icon={isClosed ? 'lock' : 'check'}>
              {isClosed ? 'Hard-closed' : current.status ? `Open (${current.status})` : 'Open (no entries yet)'}
            </StatusTag>
          </div>

          {isClosed
            ? <Banner tone="warning" title="This period is closed">Reopening is a control event — it requires a named approver and a reason, both logged.</Banner>
            : <Banner tone="info" title="This period is open">Closing seals it: no journal can post into a hard-closed period. A named approver is required.</Banner>}

          <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-3)' }}>
            <Field label="Approver" hint="The finance authoriser accepting this change" data-testid="pc-approver"
              value={approver} onChange={(e) => setApprover(e.currentTarget.value)} style={{ minWidth: 240 }} />
            {isClosed && (
              <Field label="Reason for reopening" hint="Required — logged to the audit trail" data-testid="pc-reason"
                value={reason} onChange={(e) => setReason(e.currentTarget.value)} style={{ minWidth: 280 }} />
            )}
          </div>

          <div className="scr__row" style={{ marginTop: 'var(--sancta-space-3)' }}>
            {!isClosed && (
              <Button variant="primary" tone="danger" data-testid="pc-close" disabled={busy}
                {...(needsApprover ? { disabledReason: 'A named approver is required to close a period' } : {})}
                onClick={() => submit('close')}>Close period</Button>
            )}
            {isClosed && (
              <Button variant="primary" data-testid="pc-reopen" disabled={busy}
                {...(needsApprover ? { disabledReason: 'A named approver is required to reopen a period' } : needsReason ? { disabledReason: 'A reason is required to reopen a closed period' } : {})}
                onClick={() => submit('reopen')}>Reopen period</Button>
            )}
          </div>

          {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
        </div>
      )}
    </section>
  );
}
