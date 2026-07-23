import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type PendingResult } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const VERIFIED_BY = 'demo-operator';
const PRIORITY_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = { routine: 'neutral', urgent: 'warning', stat: 'danger' };

type ReleaseOut = { resultId: string; abnormal: string; critical: boolean };

/**
 * Results entry (ORD-04) — the worklist of diagnostic orders awaiting a result,
 * STAT/urgent first. Entering a value classifies it against the reference and
 * critical bands (ORD-05): a critical result is never just displayed — it is
 * flagged and pushed onto the acknowledgement queue that leads the Inbox (ORD-07),
 * closing the order→result→critical→acknowledge loop. Releasing a result is a
 * confirmed-commit write (§9.2); the entry is preserved on any failure. Reads the
 * worklist on open, so it needs the endpoint present on the hub (it is, on both
 * the edge and the Worker).
 */
export function Results() {
  const [orders, setOrders] = useState<PendingResult[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [target, setTarget] = useState<PendingResult | null>(null);
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [refLow, setRefLow] = useState('');
  const [refHigh, setRefHigh] = useState('');
  const [critLow, setCritLow] = useState('');
  const [critHigh, setCritHigh] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => { const r = await api.pendingResults(); setOrders(r.orders); }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const choose = (o: PendingResult) => {
    setTarget(o); setValue(''); setUnit(''); setRefLow(''); setRefHigh(''); setCritLow(''); setCritHigh('');
    setIdemKey(newIdempotencyKey()); setMsg(null);
  };

  const num = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s));
  const valueNum = num(value);
  const canSubmit = target !== null && valueNum !== undefined && Number.isFinite(valueNum);

  const release = async () => {
    if (!target || !canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<ReleaseOut>(
      '/api/orders/result',
      {
        orderId: target.orderId, value: valueNum,
        ...(unit.trim() ? { unit: unit.trim() } : {}),
        ...(num(refLow) !== undefined ? { refLow: num(refLow) } : {}),
        ...(num(refHigh) !== undefined ? { refHigh: num(refHigh) } : {}),
        ...(num(critLow) !== undefined ? { criticalLow: num(critLow) } : {}),
        ...(num(critHigh) !== undefined ? { criticalHigh: num(critHigh) } : {}),
        verifiedBy: VERIFIED_BY,
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data) {
      const { abnormal, critical } = res.data;
      setMsg({ tone: critical ? 'danger' : abnormal !== 'normal' ? 'warning' : 'success',
        text: critical
          ? `CRITICAL result released and flagged (${abnormal}). It is now on the acknowledgement queue at the top of the Inbox — a clinician must act on it.`
          : abnormal !== 'normal'
            ? `Result released and flagged ${abnormal}. It appears in the patient chart.`
            : 'Result released and saved to the clinic. It appears in the patient chart.' });
      setTarget(null); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was released — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not release the result (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading results worklist" />;
  if (state === 'error') return <StateBlock state="stale" title="Worklist unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Results entry">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Orders awaiting results (ORD-04)</h3>
        <StatusTag tone={orders.length > 0 ? 'neutral' : 'success'} icon={orders.length > 0 ? null : 'check'}>
          {orders.length > 0 ? `${orders.length} pending` : 'All resulted'}
        </StatusTag>
      </div>

      {orders.length === 0
        ? <StateBlock state="empty" title="No orders awaiting results">Every diagnostic order has a result.</StateBlock>
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="res-worklist">
              <caption className="sancta-visually-hidden">Diagnostic orders awaiting a result, most urgent first. Select enter result to release one.</caption>
              <thead><tr><th scope="col">Patient</th><th scope="col">Clinic no.</th><th scope="col">Category</th><th scope="col">Code</th><th scope="col">Priority</th><th scope="col"></th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId} data-selected={target?.orderId === o.orderId || undefined}>
                    <td>{o.name}</td>
                    <td data-numeric>{o.mrn ?? '—'}</td>
                    <td>{o.category}</td>
                    <td>{o.code}</td>
                    <td><StatusTag tone={PRIORITY_TONE[o.priority] ?? 'neutral'} icon={o.priority === 'stat' ? 'alert' : null}>{o.priority}</StatusTag></td>
                    <td style={{ textAlign: 'right' }}><Button variant="primary" density="compact" data-testid="res-enter" onClick={() => choose(o)}>Enter result</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {target && (
        <div className="scr__card" data-testid="res-panel">
          <h3 className="scr__section-title">Result — {target.name} · {target.category} {target.code}</h3>
          <p className="scr__kpi-meta">Enter the measured value and, where known, the reference and critical bands. The value is classified on release; a critical value is escalated to the Inbox.</p>
          <div className="scr__form-grid">
            <Field label="Value" numeric data-testid="res-value" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
            <Field label="Unit" optional data-testid="res-unit" value={unit} onChange={(e) => setUnit(e.currentTarget.value)} />
            <Field label="Reference low" optional numeric data-testid="res-reflow" value={refLow} onChange={(e) => setRefLow(e.currentTarget.value)} />
            <Field label="Reference high" optional numeric data-testid="res-refhigh" value={refHigh} onChange={(e) => setRefHigh(e.currentTarget.value)} />
            <Field label="Critical low" optional numeric data-testid="res-critlow" value={critLow} onChange={(e) => setCritLow(e.currentTarget.value)} />
            <Field label="Critical high" optional numeric data-testid="res-crithigh" value={critHigh} onChange={(e) => setCritHigh(e.currentTarget.value)} />
          </div>
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" data-testid="res-submit" disabled={busy}
              {...(!canSubmit ? { disabledReason: 'Enter a numeric value' } : {})}
              onClick={release}>Release result</Button>
            <Button variant="subtle" data-testid="res-cancel" disabled={busy} onClick={() => { setTarget(null); setMsg(null); }}>Cancel</Button>
          </div>
          {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone !== 'success'}>{msg.text}</Banner></div>}
        </div>
      )}
      {!target && msg && <div data-testid="res-result"><Banner tone={msg.tone} assertive={msg.tone !== 'success'}>{msg.text}</Banner></div>}
    </section>
  );
}
