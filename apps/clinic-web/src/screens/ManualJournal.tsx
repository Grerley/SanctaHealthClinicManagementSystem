import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Account = { code: string; name: string; type: string; active: boolean };
type JournalRow = { id: string; memo: string; status: string; periodId: string; makerId: string; checkerId: string | null; batchId: string | null };
type DraftLine = { accountCode: string; debitMinor: number; creditMinor: number };

const emptyLine = (): DraftLine => ({ accountCode: '', debitMinor: 0, creditMinor: 0 });
const STATUS_TONE: Record<string, 'neutral' | 'info' | 'success' | 'danger'> = { draft: 'info', posted: 'success', rejected: 'danger' };

/**
 * Controlled manual journal with maker-checker (FIN-003, BR-011). A maker DRAFTS a
 * balanced journal — the balance (debits == credits, one side per line, no
 * negatives) is validated in front of the maker before it can be submitted, so a bad
 * entry never reaches a checker. A DIFFERENT checker then POSTS it through the shared
 * period-open choke point, or REJECTS it with a reason. Every write is a §9.2
 * confirmed-commit (idempotency key per intent, draft kept on failure); posting and
 * rejecting are `approve`-gated and the server enforces segregation of duties and the
 * permission authoritatively (a 403 or a self-post is surfaced, never succeeded).
 */
export function ManualJournal() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [journals, setJournals] = useState<JournalRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Draft intent (§9.2 — preserved across a failed commit).
  const [memo, setMemo] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [maker, setMaker] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [draftKey, setDraftKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [draftMsg, setDraftMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  // Checker intent (per journal).
  const [checkTarget, setCheckTarget] = useState<string | null>(null);
  const [checker, setChecker] = useState('');
  const [reason, setReason] = useState('');
  const [checkKey, setCheckKey] = useState(newIdempotencyKey());
  const [checkMsg, setCheckMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [chart, list] = await Promise.all([
      jsonFetch<{ accounts: Account[] }>('/api/finance/chart'),
      jsonFetch<{ journals: JournalRow[] }>('/api/finance/journal'),
    ]);
    setAccounts(chart.accounts.filter((a) => a.active));
    setJournals(list.journals);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const totalDebit = lines.reduce((s, l) => s + (l.debitMinor || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.creditMinor || 0), 0);
  const balanced = totalDebit === totalCredit && totalDebit > 0;
  const badLine = lines.some((l) => l.debitMinor > 0 && l.creditMinor > 0);
  const missingAccount = lines.some((l) => (l.debitMinor > 0 || l.creditMinor > 0) && !l.accountCode);
  const canDraft = !!memo.trim() && /^\d{4}-\d{2}$/.test(periodId.trim()) && !!maker.trim() && balanced && !badLine && !missingAccount;
  const draftBlock = !memo.trim() ? 'Enter a memo (why this journal exists)'
    : !/^\d{4}-\d{2}$/.test(periodId.trim()) ? 'Enter a period as year-month (e.g. 2026-07)'
    : !maker.trim() ? 'Enter the maker'
    : badLine ? 'A line cannot be both debit and credit'
    : missingAccount ? 'Every amount line needs an account'
    : !balanced ? 'Debits must equal credits and be greater than zero'
    : '';

  const setLine = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submitDraft = async () => {
    if (!canDraft) return;
    setBusy(true); setDraftMsg(null);
    const body = {
      memo: memo.trim(), periodId: periodId.trim(), maker: maker.trim(),
      lines: lines.filter((l) => l.debitMinor > 0 || l.creditMinor > 0).map((l) => ({ accountCode: l.accountCode, debitMinor: Math.round(l.debitMinor), creditMinor: Math.round(l.creditMinor) })),
    };
    const res = await mutate<{ journalId: string; status: string }>('/api/finance/journal/draft', body, { idempotencyKey: draftKey });
    setBusy(false);
    if (res.ok) {
      setDraftMsg({ tone: 'success', text: `Journal drafted (balanced at ${money(totalDebit)}). A different checker must now post or reject it.` });
      setMemo(''); setMaker(''); setLines([emptyLine(), emptyLine()]); setDraftKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.status === 403) {
      setDraftMsg({ tone: 'danger', text: 'You do not have permission to draft a journal. Your entry is kept.' });
    } else if (res.errorCode === 'network') {
      setDraftMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was saved — your entry is kept; retry when connected.' });
    } else {
      setDraftMsg({ tone: 'danger', text: `Journal rejected (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const beginCheck = (id: string) => { setCheckTarget(id); setChecker(''); setReason(''); setCheckKey(newIdempotencyKey()); setCheckMsg(null); };

  const submitCheck = async (action: 'post' | 'reject') => {
    if (!checkTarget || !checker.trim()) return;
    if (action === 'reject' && !reason.trim()) return;
    setBusy(true); setCheckMsg(null);
    const body = action === 'post'
      ? { journalId: checkTarget, checker: checker.trim() }
      : { journalId: checkTarget, checker: checker.trim(), reason: reason.trim() };
    const res = await mutate<{ journalId: string; status: string; batchId?: string }>(`/api/finance/journal/${action}`, body, { idempotencyKey: checkKey });
    setBusy(false);
    if (res.ok) {
      setCheckMsg({ tone: 'success', text: action === 'post'
        ? `Journal posted to the ledger${res.data?.batchId ? ` as batch ···${res.data.batchId.slice(-8)}` : ''}.`
        : `Journal rejected. Reason logged: "${reason.trim()}".` });
      setCheckTarget(null); setCheckKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.status === 403) {
      setCheckMsg({ tone: 'danger', text: 'You do not have permission to approve journals — a finance approver is required. Nothing was changed.' });
    } else if (res.errorCode === 'network') {
      setCheckMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was changed — your entry is kept; retry when connected.' });
    } else {
      setCheckMsg({ tone: 'danger', text: `Action blocked (${res.errorMessage ?? res.errorCode ?? 'error'}). A checker cannot post their own draft. Your entry is kept.` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading manual journals" />;
  if (state === 'error') return <StateBlock state="stale" title="Manual journals unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Manual journal">
      <div className="scr__card" data-testid="mj-draft">
        <h3 className="scr__section-title">Draft a manual journal</h3>
        <div className="scr__row" style={{ alignItems: 'flex-end' }}>
          <Field label="Memo" hint="Why this journal exists" data-testid="mj-memo" value={memo} onChange={(e) => setMemo(e.currentTarget.value)} style={{ minWidth: 280 }} />
          <Field label="Period" hint="Year-month, e.g. 2026-07" data-testid="mj-period" value={periodId} onChange={(e) => setPeriodId(e.currentTarget.value)} style={{ maxWidth: 180 }} />
          <Field label="Maker" hint="Who is raising this" data-testid="mj-maker" value={maker} onChange={(e) => setMaker(e.currentTarget.value)} style={{ maxWidth: 200 }} />
        </div>

        <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <table className="scr__table" data-testid="mj-lines">
            <caption className="sancta-visually-hidden">Journal lines — each line is either a debit or a credit</caption>
            <thead><tr><th scope="col">Account</th><th scope="col" style={{ textAlign: 'right' }}>Debit (¢)</th><th scope="col" style={{ textAlign: 'right' }}>Credit (¢)</th><th scope="col"></th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <label className="sancta-field" style={{ minWidth: 240 }}>
                      <span className="sancta-visually-hidden">Account for line {i + 1}</span>
                      <select className="sancta-field-input" data-testid={`mj-account-${i}`} value={l.accountCode} onChange={(e) => setLine(i, { accountCode: e.target.value })}>
                        <option value="">Select account…</option>
                        {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name} ({a.type})</option>)}
                      </select>
                    </label>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Field label={`Debit for line ${i + 1}`} hideLabel numeric min={0} step={1} data-testid={`mj-debit-${i}`}
                      value={l.debitMinor} onChange={(e) => setLine(i, { debitMinor: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })} style={{ maxWidth: 140, marginInlineStart: 'auto' }} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Field label={`Credit for line ${i + 1}`} hideLabel numeric min={0} step={1} data-testid={`mj-credit-${i}`}
                      value={l.creditMinor} onChange={(e) => setLine(i, { creditMinor: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })} style={{ maxWidth: 140, marginInlineStart: 'auto' }} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Button variant="subtle" density="compact" data-testid={`mj-remove-${i}`}
                      {...(lines.length <= 2 ? { disabledReason: 'A journal needs at least two lines' } : {})}
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--sancta-colour-border)' }}>
                <td>Totals</td>
                <td data-numeric style={{ textAlign: 'right' }} data-testid="mj-total-debit">{money(totalDebit)}</td>
                <td data-numeric style={{ textAlign: 'right' }} data-testid="mj-total-credit">{money(totalCredit)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="subtle" density="compact" data-testid="mj-add-line" onClick={() => setLines((ls) => [...ls, emptyLine()])}>Add line</Button>
          <StatusTag tone={balanced && !badLine ? 'success' : 'warning'} icon={balanced && !badLine ? 'check' : 'alert'}>
            {badLine ? 'A line is both debit and credit' : balanced ? `Balanced at ${money(totalDebit)}` : `Out of balance by ${money(Math.abs(totalDebit - totalCredit))}`}
          </StatusTag>
          <Button variant="primary" data-testid="mj-submit" disabled={busy}
            {...(canDraft ? {} : { disabledReason: draftBlock })}
            onClick={submitDraft}>Draft journal</Button>
        </div>
        {draftMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={draftMsg.tone} assertive={draftMsg.tone === 'danger'}>{draftMsg.text}</Banner></div>}
      </div>

      <div>
        <h3 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-4)' }}>Journals</h3>
        {journals.length === 0
          ? <StateBlock state="empty" title="No manual journals yet">Draft one above; a different checker then posts or rejects it.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="mj-journals">
                <caption className="sancta-visually-hidden">Manual journals with their maker-checker status</caption>
                <thead><tr><th scope="col">Memo</th><th scope="col">Period</th><th scope="col">Maker</th><th scope="col">Checker</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
                <tbody>
                  {journals.map((j) => (
                    <tr key={j.id} data-selected={checkTarget === j.id || undefined}>
                      <td>{j.memo}</td>
                      <td data-numeric>{j.periodId}</td>
                      <td>{j.makerId}</td>
                      <td>{j.checkerId ?? '—'}</td>
                      <td><StatusTag tone={STATUS_TONE[j.status] ?? 'neutral'}>{j.status}</StatusTag></td>
                      <td style={{ textAlign: 'right' }}>
                        {j.status === 'draft'
                          ? <Button variant="subtle" density="compact" data-testid="mj-check" onClick={() => beginCheck(j.id)}>Review</Button>
                          : <span className="scr__kpi-meta">{j.batchId ? `batch ···${j.batchId.slice(-8)}` : '—'}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {checkTarget && (
        <div className="scr__card" data-testid="mj-check-panel" style={{ marginTop: 'var(--sancta-space-4)' }}>
          <h3 className="scr__section-title">Review draft journal</h3>
          <Banner tone="info" title="Segregation of duties">The checker must be a different person from the maker; the clinic hub rejects a self-post.</Banner>
          <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-3)' }}>
            <Field label="Checker" hint="Who is approving — must differ from the maker" data-testid="mj-checker" value={checker} onChange={(e) => setChecker(e.currentTarget.value)} style={{ minWidth: 240 }} />
            <Field label="Rejection reason" optional hint="Required only to reject" data-testid="mj-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} style={{ minWidth: 280 }} />
          </div>
          <div className="scr__row" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" data-testid="mj-post" disabled={busy}
              {...(!checker.trim() ? { disabledReason: 'Enter the checker' } : {})}
              onClick={() => submitCheck('post')}>Post to ledger</Button>
            <Button variant="primary" tone="danger" data-testid="mj-reject" disabled={busy}
              {...(!checker.trim() ? { disabledReason: 'Enter the checker' } : !reason.trim() ? { disabledReason: 'A reason is required to reject' } : {})}
              onClick={() => submitCheck('reject')}>Reject</Button>
            <Button variant="subtle" data-testid="mj-check-cancel" disabled={busy} onClick={() => { setCheckTarget(null); setCheckMsg(null); }}>Cancel</Button>
          </div>
          {checkMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={checkMsg.tone} assertive={checkMsg.tone === 'danger'}>{checkMsg.text}</Banner></div>}
        </div>
      )}
      {!checkTarget && checkMsg && <div data-testid="mj-check-result"><Banner tone={checkMsg.tone}>{checkMsg.text}</Banner></div>}
    </section>
  );
}
