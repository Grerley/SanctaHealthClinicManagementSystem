import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type WorklistItem = { requestId: string; patientId: string; medicineCode: string; dose: string | null; quantity: number | null; prescribedBy: string | null };

/**
 * Dispensing worklist (MED-005). Prescriptions awaiting the pharmacy. Marking an item
 * dispensed decrements stock server-side under a row lock — a failed mark keeps the item
 * on the list. Confirmed-commit write (§9.2); the worklist reloads after each mark.
 */
export function DispenseWorklist() {
  const [rows, setRows] = useState<WorklistItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try { const r = await jsonFetch<{ worklist: WorklistItem[] }>('/api/dispense/worklist'); setRows(r.worklist); setState('ready'); }
    catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mark = async (requestId: string) => {
    setBusy(requestId); setMsg(null);
    const res = await mutate<{ requestId: string }>('/api/dispense/mark', { requestId }, { idempotencyKey: newIdempotencyKey() });
    setBusy(null);
    if (res.ok) { setMsg({ tone: 'success', text: `Dispensed ···${requestId.slice(-8)}.` }); try { await load(); } catch { /* covered */ } }
    else if (res.errorCode === 'network') setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected.' });
    else setMsg({ tone: 'danger', text: `Could not dispense (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}).` });
  };

  return (
    <section className="scr" aria-label="Dispensing worklist">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Awaiting dispensing</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="dispense-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          <StatusTag tone={rows.length > 0 ? 'warning' : 'success'} icon={rows.length > 0 ? 'alert' : 'check'}>{rows.length > 0 ? `${rows.length} waiting` : 'All dispensed'}</StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading worklist" />}
        {state === 'error' && <StateBlock state="stale" title="Worklist unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          rows.length === 0
            ? <StateBlock state="empty" title="Nothing to dispense">No prescriptions are waiting.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="dispense-worklist">
                  <caption className="sancta-visually-hidden">Prescriptions awaiting dispensing</caption>
                  <thead><tr><th scope="col">Medicine</th><th scope="col">Dose</th><th scope="col">Qty</th><th scope="col">Patient</th><th scope="col"></th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.requestId}>
                        <td>{r.medicineCode}</td>
                        <td>{r.dose ?? '—'}</td>
                        <td data-numeric>{r.quantity ?? '—'}</td>
                        <td data-numeric>···{r.patientId.slice(-8)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <Button variant="primary" density="compact" data-testid={`dispense-mark-${r.requestId.slice(-8)}`} disabled={busy === r.requestId} onClick={() => mark(r.requestId)}>Mark dispensed</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
