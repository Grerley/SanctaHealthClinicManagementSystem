import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type HandoverItem } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

// The demo operator is both sender and recipient so a handover round-trips visibly.
const ME = 'demo-operator';

const SBAR: Array<{ key: 'situation' | 'background' | 'assessment' | 'recommendation'; label: string; hint: string }> = [
  { key: 'situation', label: 'Situation', hint: 'What is happening now' },
  { key: 'background', label: 'Background', hint: 'Relevant history and context' },
  { key: 'assessment', label: 'Assessment', hint: 'Your clinical assessment' },
  { key: 'recommendation', label: 'Recommendation', hint: 'What the next clinician should do' },
];
type Sbar = Partial<Record<(typeof SBAR)[number]['key'], string>>;

/** Compose the four SBAR parts into one structured message the hub stores verbatim. */
function composeSbar(s: Sbar): string {
  return SBAR.filter((f) => (s[f.key] ?? '').trim()).map((f) => `${f.label}: ${(s[f.key] ?? '').trim()}`).join('\n');
}

/**
 * Clinical handover (SBAR, EHR-012). Shift-change continuity is a safety concern —
 * a handover carries a structured SBAR message to the next clinician and is not
 * cleared until they ACKNOWLEDGE it, so nothing critical is silently dropped between
 * shifts. Sending and acknowledging are confirmed-commit writes (§9.2); the SBAR
 * draft is preserved on any failure. Reads the recipient's inbox on open (endpoint
 * now present on both the edge and the Worker after path reconciliation).
 */
export function Handover() {
  const [items, setItems] = useState<HandoverItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [to, setTo] = useState(ME);
  const [sbar, setSbar] = useState<Sbar>({});
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => { const r = await api.handoverInbox(ME); setItems(r.inbox); }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const message = composeSbar(sbar);
  const canSend = to.trim().length > 0 && message.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/handover', { toStaff: to.trim(), fromStaff: ME, message }, { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Handover sent to ${to.trim()}. It stays on their inbox until acknowledged.` });
      setSbar({}); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The handover was NOT sent — your SBAR is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not send the handover (${res.errorCode ?? 'error'}). Your SBAR is kept.` });
    }
  };

  const acknowledge = async (item: HandoverItem) => {
    setAckBusy(item.id); setMsg(null);
    const res = await mutate<{ status: string }>(
      '/api/handover/acknowledge', { id: item.id, by: ME }, { idempotencyKey: newIdempotencyKey() },
    );
    setAckBusy(null);
    if (res.ok) { try { await load(); } catch { /* covered */ } }
    else if (res.errorCode === 'network') setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — the acknowledgement was not recorded. Retry when connected.' });
    else setMsg({ tone: 'danger', text: `Could not acknowledge (${res.errorCode ?? 'error'}).` });
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading handover inbox" />;
  if (state === 'error') return <StateBlock state="stale" title="Handover unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Clinical handover">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">My handover inbox</h3>
          <StatusTag tone={items.length > 0 ? 'warning' : 'success'} icon={items.length > 0 ? 'alert' : 'check'}>
            {items.length > 0 ? `${items.length} to acknowledge` : 'All acknowledged'}
          </StatusTag>
        </div>
        {items.length === 0
          ? <StateBlock state="empty" title="No handovers waiting">Nothing has been handed over to you that needs acknowledgement.</StateBlock>
          : (
            <ul className="scr__addenda" data-testid="ho-inbox">
              {items.map((h) => (
                <li key={h.id} className="scr__card">
                  <div className="scr__kpi-meta">From {h.fromStaff ?? 'unknown'} · {h.createdAt.slice(0, 16).replace('T', ' ')}</div>
                  <div style={{ whiteSpace: 'pre-wrap', margin: 'var(--sancta-space-1) 0' }}>{h.message}</div>
                  <Button variant="secondary" density="compact" data-testid="ho-ack" disabled={ackBusy === h.id} onClick={() => acknowledge(h)}>Acknowledge</Button>
                </li>
              ))}
            </ul>
          )}
      </div>

      <div className="scr__card" data-testid="ho-send">
        <h3 className="scr__section-title">Hand over (SBAR)</h3>
        <div className="scr__row" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="To (staff)" hint="Recipient who must acknowledge" data-testid="ho-to" value={to} onChange={(e) => setTo(e.currentTarget.value)} style={{ minWidth: 220 }} />
        </div>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
          {SBAR.map((f) => (
            <label key={f.key} className="sancta-field">
              <span className="sancta-field__label">{f.label}</span>
              <span className="sancta-field__hint">{f.hint}</span>
              <textarea className="sancta-field-input scr__textarea" data-testid={`ho-${f.key}`} rows={2}
                value={sbar[f.key] ?? ''} onChange={(e) => setSbar((s) => ({ ...s, [f.key]: e.currentTarget.value }))} />
            </label>
          ))}
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="ho-submit" disabled={busy}
            {...(!canSend ? { disabledReason: 'Add a recipient and at least one SBAR field' } : {})}
            onClick={send}>Send handover</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
