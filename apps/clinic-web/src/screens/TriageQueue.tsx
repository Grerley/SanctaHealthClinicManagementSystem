import { Fragment, useCallback, useEffect, useState } from 'react';
import { Banner, Button, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const SIGNED_BY = 'demo-operator';

type TriageQueueRow = { encounterId: string; visitId: string; patientId: string; ewsScore: number | null; ewsBand: string | null; dangerCount: number };
type TriageSummary = {
  assessment: Record<string, unknown> | null;
  interventions: Array<{ kind: string; detail: string | null; medication: string | null; response: string | null; at: string }>;
  trend: Record<string, Array<{ value: number; flag: string; at: string }>>;
};

const BAND_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = { low: 'neutral', medium: 'warning', high: 'danger' };

function triageQueue(): Promise<{ queue: TriageQueueRow[] }> { return jsonFetch<{ queue: TriageQueueRow[] }>('/api/triage/queue'); }
function triageSummary(encounterId: string): Promise<TriageSummary> {
  return jsonFetch<TriageSummary>(`/api/triage/summary?encounterId=${encodeURIComponent(encounterId)}`);
}

/**
 * Triage work queue (TRI-008). Unsigned triage assessments, highest early-warning
 * score first — the clinical priority order the backend returns. Expanding a row
 * reads the full triage picture (assessment, interventions, repeat-observation trend
 * — TRI-007). Signing hands the patient off and removes them from the queue; it is a
 * confirmed-commit write (§9.2) and is refused (409) if there is nothing to sign or
 * it is already signed. The queue re-reads after a sign.
 */
export function TriageQueue() {
  const [rows, setRows] = useState<TriageQueueRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [summary, setSummary] = useState<TriageSummary | null>(null);
  const [summaryState, setSummaryState] = useState<'idle' | 'loading' | 'error'>('idle');

  const load = useCallback(async () => { setRows((await triageQueue()).queue); }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const toggle = async (row: TriageQueueRow) => {
    if (openId === row.encounterId) { setOpenId(null); setSummary(null); return; }
    setOpenId(row.encounterId); setSummary(null); setSummaryState('loading');
    try { setSummary(await triageSummary(row.encounterId)); setSummaryState('idle'); }
    catch { setSummaryState('error'); }
  };

  const sign = async (row: TriageQueueRow) => {
    setBusy(true); setMsg(null);
    const res = await mutate<{ status: string }>(
      '/api/triage/sign',
      { encounterId: row.encounterId, signedBy: SIGNED_BY },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false);
    if (res.ok && res.data?.status === 'signed') {
      setMsg({ tone: 'success', text: `Triage signed and handed off. The patient has left the triage queue.` });
      if (openId === row.encounterId) { setOpenId(null); setSummary(null); }
      try { await load(); } catch { /* keep stale */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The triage is unchanged; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not sign the triage (${res.errorCode ?? 'error'}).` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading triage queue" />;
  if (state === 'error') return <StateBlock state="stale" title="Triage queue unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Triage queue">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Triage queue (TRI-008)</h3>
        <div className="scr__row" style={{ alignItems: 'center' }}>
          <StatusTag tone={rows.length > 0 ? 'warning' : 'success'} icon={rows.length > 0 ? 'alert' : 'check'}>
            {rows.length > 0 ? `${rows.length} awaiting sign-off` : 'Queue clear'}
          </StatusTag>
          <Button variant="subtle" density="compact" data-testid="tq-refresh" disabled={busy} onClick={() => { void load(); }}>Refresh</Button>
        </div>
      </div>

      {msg && <Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner>}

      {rows.length === 0
        ? <StateBlock state="empty" title="No unsigned triage">Every triaged patient has been signed off and handed on.</StateBlock>
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="tq-board">
              <caption className="sancta-visually-hidden">Unsigned triage assessments, highest early-warning score first.</caption>
              <thead><tr><th scope="col">EWS</th><th scope="col">Band</th><th scope="col">Danger signs</th><th scope="col">Encounter</th><th scope="col"></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.encounterId}>
                    <tr data-selected={openId === r.encounterId || undefined}>
                      <td data-numeric><strong>{r.ewsScore ?? '—'}</strong></td>
                      <td>{r.ewsBand ? <StatusTag tone={BAND_TONE[r.ewsBand] ?? 'neutral'} icon={r.ewsBand === 'high' ? 'alert' : null}>{r.ewsBand}</StatusTag> : '—'}</td>
                      <td data-numeric>{r.dangerCount > 0 ? <StatusTag tone="danger" icon="alert">{String(r.dangerCount)}</StatusTag> : '0'}</td>
                      <td data-numeric>···{r.encounterId.slice(-8)}</td>
                      <td>
                        <div className="scr__row">
                          <Button density="compact" variant="secondary" data-testid="tq-view" onClick={() => { void toggle(r); }} aria-expanded={openId === r.encounterId}>
                            {openId === r.encounterId ? 'Hide' : 'View'}
                          </Button>
                          <Button density="compact" variant="primary" data-testid="tq-sign" disabled={busy} onClick={() => sign(r)}>Sign &amp; hand off</Button>
                        </div>
                      </td>
                    </tr>
                    {openId === r.encounterId && (
                      <tr>
                        <td colSpan={5}>
                          {summaryState === 'loading' && <StateBlock state="initial-loading" title="Loading triage detail" />}
                          {summaryState === 'error' && <StateBlock state="stale" title="Detail unavailable">The clinic hub may be unreachable.</StateBlock>}
                          {summaryState === 'idle' && summary && (
                            <div data-testid="tq-summary">
                              <p className="scr__kpi-meta"><strong>Assessment:</strong> {summary.assessment ? JSON.stringify(summary.assessment) : 'None recorded.'}</p>
                              <p className="scr__kpi-meta"><strong>Interventions:</strong> {summary.interventions.length === 0 ? 'None.' : summary.interventions.map((iv) => `${iv.kind}${iv.response ? ' → ' + iv.response : ''}`).join('; ')}</p>
                              <p className="scr__kpi-meta"><strong>Observations:</strong> {Object.keys(summary.trend).length === 0 ? 'None.' : Object.entries(summary.trend).map(([k, v]) => `${k}: ${v.map((o) => o.value).join(', ')}`).join(' | ')}</p>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
