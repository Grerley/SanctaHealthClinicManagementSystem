import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type QueueRow } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/** Common stations a visit flows through — offered as quick transfer targets. */
const STATIONS = ['reception', 'triage', 'clinician', 'pharmacy', 'cashier', 'lab'];

/**
 * Visit / flow board (VIS-003/005/008). The live queue across all stations, visible
 * across LAN devices. A visit can be transferred to the next station (VIS-005) and
 * completed (VIS-008). Completion is guarded by the backend: a visit with unsigned
 * encounters or unacknowledged critical results is refused (409) and the blocking
 * tasks are listed — an authorised override with a reason can force the close. Both
 * writes are confirmed-commit (§9.2). The board re-reads after each write.
 */
export function VisitBoard() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [transferTo, setTransferTo] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [blocked, setBlocked] = useState<{ visitId: string; token: number; unresolved: string[] } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => { setRows((await api.queue()).queue); }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const transfer = async (row: QueueRow) => {
    const toStation = transferTo[row.visitId];
    if (!toStation) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ ok: boolean }>(
      '/api/visits/transfer',
      { visitId: row.visitId, toStation },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Token ${row.token} transferred to ${toStation}.` });
      try { await load(); } catch { /* keep stale */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The visit is unchanged; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not transfer the visit (${res.errorCode ?? 'error'}).` });
    }
  };

  const complete = async (row: QueueRow, override: boolean) => {
    setBusy(true); setMsg(null);
    const res = await mutate<{ ok: boolean; unresolved?: string[] }>(
      '/api/visits/complete',
      { visitId: row.visitId, ...(override ? { override: true, reason: reason.trim() || 'operational override' } : {}) },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false);
    if (res.ok) {
      setBlocked(null); setReason('');
      setMsg({ tone: 'success', text: override ? `Token ${row.token} closed with an authorised override.` : `Token ${row.token} completed.` });
      try { await load(); } catch { /* keep stale */ }
    } else if (res.status === 409 && res.data?.unresolved) {
      setBlocked({ visitId: row.visitId, token: row.token, unresolved: res.data.unresolved });
      setMsg({ tone: 'warning', text: `Token ${row.token} cannot be completed yet — ${res.data.unresolved.length} task(s) outstanding. Resolve them, or override with a reason.` });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The visit is unchanged; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not complete the visit (${res.errorCode ?? 'error'}).` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading the visit board" />;
  if (state === 'error') return <StateBlock state="stale" title="Visit board unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Visit flow board">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Visit flow board (VIS-003)</h3>
        <div className="scr__row" style={{ alignItems: 'center' }}>
          <StatusTag tone={rows.length > 0 ? 'neutral' : 'success'} icon={rows.length > 0 ? null : 'check'}>
            {rows.length > 0 ? `${rows.length} in flow` : 'Board clear'}
          </StatusTag>
          <Button variant="subtle" density="compact" data-testid="vb-refresh" disabled={busy} onClick={() => { void load(); }}>Refresh</Button>
        </div>
      </div>

      {msg && <Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner>}

      {blocked && (
        <div className="scr__card" data-testid="vb-override">
          <h3 className="scr__section-title">Completion blocked — token {blocked.token}</h3>
          <ul className="scr__list">
            {blocked.unresolved.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
          <p className="scr__kpi-meta">An override is audited. Enter the reason it is safe to close the visit with these tasks outstanding.</p>
          <Field label="Override reason" data-testid="vb-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="secondary" tone="danger" data-testid="vb-override-confirm" disabled={busy}
              {...(reason.trim().length === 0 ? { disabledReason: 'A reason is required to override' } : {})}
              onClick={() => { const r = rows.find((x) => x.visitId === blocked.visitId); if (r) void complete(r, true); }}>Override and close</Button>
            <Button variant="subtle" data-testid="vb-override-cancel" disabled={busy} onClick={() => { setBlocked(null); setReason(''); }}>Keep open</Button>
          </div>
        </div>
      )}

      {rows.length === 0
        ? <StateBlock state="empty" title="No visits in flow">Check patients in from Reception to populate the board.</StateBlock>
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="vb-board">
              <caption className="sancta-visually-hidden">Visits currently in flow across stations, with transfer and complete actions.</caption>
              <thead><tr><th scope="col">Token</th><th scope="col">Station</th><th scope="col">Clinic no.</th><th scope="col">Status</th><th scope="col">Transfer to</th><th scope="col"></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.visitId}>
                    <td data-numeric><strong>{r.token}</strong></td>
                    <td>{r.station}</td>
                    <td data-numeric>{r.patientMrn ?? '—'}</td>
                    <td><StatusTag tone="neutral">{r.status}</StatusTag></td>
                    <td>
                      <label className="sancta-field" style={{ minWidth: 150, margin: 0 }}>
                        <span className="sancta-visually-hidden">Transfer token {r.token} to station</span>
                        <select className="sancta-field-input" data-testid="vb-station" value={transferTo[r.visitId] ?? ''} onChange={(e) => setTransferTo((p) => ({ ...p, [r.visitId]: e.target.value }))}>
                          <option value="">Choose station…</option>
                          {STATIONS.filter((s) => s !== r.station).map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </label>
                    </td>
                    <td>
                      <div className="scr__row">
                        <Button density="compact" variant="secondary" data-testid="vb-transfer" disabled={busy}
                          {...(!transferTo[r.visitId] ? { disabledReason: 'Choose a station to transfer to' } : {})}
                          onClick={() => transfer(r)}>Transfer</Button>
                        <Button density="compact" variant="primary" data-testid="vb-complete" disabled={busy} onClick={() => complete(r, false)}>Complete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
