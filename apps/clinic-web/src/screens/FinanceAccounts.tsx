import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
type Account = { code: string; version: number; name: string; type: AccountType; active: boolean; parentCode?: string; effectiveFrom: string; effectiveTo?: string };

const ACCOUNT_TYPES: readonly AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
function isoToday(): string { return new Date().toISOString().slice(0, 10); }

/**
 * Chart of accounts (FIN-001). Account definitions are effective-dated: defining an
 * account creates version 1, and revising it adds a NEW effective-dated version and
 * closes the prior one — codes and posted history are never rewritten. The chart
 * read resolves the definition in force on the as-of date, safe to load on mount and
 * re-query. Defining and revising are §9.2 confirmed-commit config writes (idempotency
 * key per intent, draft kept on failure); the chart reloads only after the hub commits.
 */
export function FinanceAccounts() {
  const [asOf, setAsOf] = useState(isoToday());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Define draft.
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('asset');
  const [parentCode, setParentCode] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(isoToday());
  const [defIdem, setDefIdem] = useState(newIdempotencyKey());
  const [defBusy, setDefBusy] = useState(false);
  const [defMsg, setDefMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Revise draft.
  const [revCode, setRevCode] = useState('');
  const [revName, setRevName] = useState('');
  const [revType, setRevType] = useState<'' | AccountType>('');
  const [revActive, setRevActive] = useState<'unchanged' | 'active' | 'inactive'>('unchanged');
  const [revEffectiveFrom, setRevEffectiveFrom] = useState(isoToday());
  const [revIdem, setRevIdem] = useState(newIdempotencyKey());
  const [revBusy, setRevBusy] = useState(false);
  const [revMsg, setRevMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (d: string) => {
    setState('loading');
    try {
      const r = await jsonFetch<{ asOf: string; accounts: Account[] }>(`/api/finance/chart?asOf=${encodeURIComponent(d)}`);
      setAccounts(r.accounts); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(asOf); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const codeRe = /^[0-9]{3,4}-[A-Z0-9-]+$/;
  const defReady = codeRe.test(code.trim()) && name.trim() !== '' && effectiveFrom.trim() !== '';
  const defBlock = !codeRe.test(code.trim()) ? 'Enter a code as NNNN-UPPER-KEBAB (e.g. 4000-SERVICE-REVENUE)'
    : name.trim() === '' ? 'Enter the account name'
    : effectiveFrom.trim() === '' ? 'Enter the effective-from date'
    : '';

  const define = async () => {
    if (!defReady) return;
    setDefBusy(true); setDefMsg(null);
    const body = {
      code: code.trim(),
      name: name.trim(),
      type,
      effectiveFrom,
      ...(parentCode.trim() ? { parentCode: parentCode.trim() } : {}),
    };
    const res = await mutate<{ code: string; version: number }>('/api/finance/account', body, { idempotencyKey: defIdem });
    setDefBusy(false);
    if (res.ok && res.data) {
      setDefMsg({ tone: 'success', text: `Account ${res.data.code} defined (version ${res.data.version}).` });
      setCode(''); setName(''); setParentCode(''); setDefIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setDefMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else if (res.errorCode === 'chart_rejected') {
      setDefMsg({ tone: 'danger', text: `Rejected (${res.errorMessage ?? 'the code may already exist — revise it instead'}). Your entry is kept.` });
    } else {
      setDefMsg({ tone: 'danger', text: `Could not define the account (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const beginRevise = (a: Account) => { setRevCode(a.code); setRevName(''); setRevType(''); setRevActive('unchanged'); setRevEffectiveFrom(isoToday()); setRevIdem(newIdempotencyKey()); setRevMsg(null); };

  const revReady = revCode.trim() !== '' && revEffectiveFrom.trim() !== '';
  const revise = async () => {
    if (!revReady) return;
    setRevBusy(true); setRevMsg(null);
    const body = {
      code: revCode.trim(),
      effectiveFrom: revEffectiveFrom,
      ...(revName.trim() ? { name: revName.trim() } : {}),
      ...(revType !== '' ? { type: revType } : {}),
      ...(revActive !== 'unchanged' ? { active: revActive === 'active' } : {}),
    };
    const res = await mutate<{ code: string; version: number }>('/api/finance/account/revise', body, { idempotencyKey: revIdem });
    setRevBusy(false);
    if (res.ok && res.data) {
      setRevMsg({ tone: 'success', text: `Account ${res.data.code} revised to version ${res.data.version}.` });
      setRevCode(''); setRevName(''); setRevType(''); setRevActive('unchanged'); setRevIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setRevMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else if (res.errorCode === 'chart_rejected') {
      setRevMsg({ tone: 'danger', text: `Rejected (${res.errorMessage ?? 'the effective date must be after the current version'}). Your entry is kept.` });
    } else {
      setRevMsg({ tone: 'danger', text: `Could not revise the account (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const activeCount = accounts.filter((a) => a.active).length;

  return (
    <section className="scr" aria-label="Chart of accounts">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Chart of accounts (FIN-001)</h3>
            <Field label="As of" type="date" hint="Definitions in force on this date" data-testid="acct-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="acct-refresh" disabled={state === 'loading'} onClick={() => void load(asOf)}>Refresh</Button>
          </div>
          <StatusTag tone={activeCount > 0 ? 'success' : 'neutral'} icon={activeCount > 0 ? 'check' : 'info'}>{`${activeCount} active`}</StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading chart of accounts" />}
        {state === 'error' && <StateBlock state="stale" title="Chart of accounts unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          accounts.length === 0
            ? <StateBlock state="empty" title="No accounts in force">No account definition is effective on this date. Define one below.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="acct-list">
                  <caption className="sancta-visually-hidden">Chart of accounts in force on the selected date, with version and status</caption>
                  <thead><tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Version</th>
                    <th scope="col">Effective from</th>
                    <th scope="col">Status</th>
                    <th scope="col"></th>
                  </tr></thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.code} data-selected={revCode === a.code || undefined}>
                        <td data-numeric>{a.code}</td>
                        <td>{a.name}</td>
                        <td>{a.type}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{a.version}</td>
                        <td data-numeric>{a.effectiveFrom}</td>
                        <td><StatusTag tone={a.active ? 'success' : 'neutral'} icon={a.active ? 'check' : null}>{a.active ? 'active' : 'inactive'}</StatusTag></td>
                        <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid="acct-revise" onClick={() => beginRevise(a)}>Revise</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      {revCode && (
        <div className="scr__card" data-testid="acct-revise-form">
          <h3 className="scr__section-title">Revise an account</h3>
          <p className="scr__kpi-meta">A revision adds a new effective-dated version and closes the prior one — history is never rewritten. The effective date must be after the current version's. Leave a field blank to keep its current value. Account code: {revCode}.</p>
          <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
            <Field label="New name" optional hint="Blank keeps the current name" data-testid="acct-rev-name" value={revName} onChange={(e) => setRevName(e.currentTarget.value)} />
            <label className="sancta-field">
              <span className="sancta-field__label">New type (Optional)</span>
              <select className="sancta-field-input" data-testid="acct-rev-type" value={revType} onChange={(e) => { const v = e.currentTarget.value; setRevType(v === '' ? '' : v as AccountType); }}>
                <option value="">Keep current</option>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="sancta-field">
              <span className="sancta-field__label">Status (Optional)</span>
              <select className="sancta-field-input" data-testid="acct-rev-active" value={revActive} onChange={(e) => { const v = e.currentTarget.value; setRevActive(v === 'active' ? 'active' : v === 'inactive' ? 'inactive' : 'unchanged'); }}>
                <option value="unchanged">Keep current</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <Field label="Effective from" type="date" hint="Must be after the current version's date" data-testid="acct-rev-effective" value={revEffectiveFrom} onChange={(e) => setRevEffectiveFrom(e.currentTarget.value)} />
          </div>
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" icon={<Icon name="check" />} data-testid="acct-rev-submit" disabled={revBusy}
              {...(revEffectiveFrom.trim() === '' ? { disabledReason: 'Enter the effective-from date' } : {})}
              onClick={revise}>Revise account</Button>
            <Button variant="subtle" data-testid="acct-rev-cancel" disabled={revBusy} onClick={() => { setRevCode(''); setRevMsg(null); }}>Cancel</Button>
          </div>
          {revMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={revMsg.tone} assertive={revMsg.tone === 'danger'}>{revMsg.text}</Banner></div>}
        </div>
      )}
      {!revCode && revMsg && <div data-testid="acct-rev-result"><Banner tone={revMsg.tone}>{revMsg.text}</Banner></div>}

      <div className="scr__card" data-testid="acct-define-form">
        <h3 className="scr__section-title">Define an account</h3>
        <p className="scr__kpi-meta">A new account starts at version 1. Codes are NNNN-UPPER-KEBAB (e.g. 4000-SERVICE-REVENUE). The clinic hub rejects a duplicate code — revise it instead.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Code" hint="NNNN-UPPER-KEBAB" data-testid="acct-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Name" hint="What the account is" data-testid="acct-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <label className="sancta-field">
            <span className="sancta-field__label">Type</span>
            <select className="sancta-field-input" data-testid="acct-type" value={type} onChange={(e) => setType(e.currentTarget.value as AccountType)}>
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <Field label="Parent code" optional hint="Roll-up parent account" data-testid="acct-parent" value={parentCode} onChange={(e) => setParentCode(e.currentTarget.value)} />
          <Field label="Effective from" type="date" hint="When the account becomes effective" data-testid="acct-effective" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="acct-define-submit" disabled={defBusy}
            {...(defReady ? {} : { disabledReason: defBlock })}
            onClick={define}>Define account</Button>
        </div>
        {defMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={defMsg.tone} assertive={defMsg.tone === 'danger'}>{defMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
