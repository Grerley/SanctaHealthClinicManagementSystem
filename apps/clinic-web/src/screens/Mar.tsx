import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type DueMedication } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const PERFORMER = 'demo-operator';

/**
 * Medication administration record (MAR, MED-09) — the worklist of active
 * medication requests due to be given. Recording an administration captures the
 * given/not-given outcome; a NOT-GIVEN dose can never be recorded blank — it
 * requires a reason (dose withheld, refused, unavailable…), enforced both here and
 * by the hub (a CHECK constraint / 422). Administrations are append-only and
 * audited. Recording is a confirmed-commit write (§9.2); the entry is preserved on
 * any failure. Reads the worklist on open (endpoint present on both backends).
 */
export function Mar() {
  const [meds, setMeds] = useState<DueMedication[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [target, setTarget] = useState<DueMedication | null>(null);
  const [outcome, setOutcome] = useState<'given' | 'not_given'>('given');
  const [reason, setReason] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => { const r = await api.dueMedications(); setMeds(r.medications); }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [load]);

  const choose = (m: DueMedication) => { setTarget(m); setOutcome('given'); setReason(''); setIdemKey(newIdempotencyKey()); setMsg(null); };

  const notGivenNeedsReason = outcome === 'not_given' && !reason.trim();

  const record = async () => {
    if (!target || notGivenNeedsReason) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/prescribe/administer',
      { requestId: target.requestId, status: outcome, performer: PERFORMER, ...(target.dose ? { dose: target.dose } : {}), ...(target.route ? { route: target.route } : {}), ...(outcome === 'not_given' ? { reason: reason.trim() } : {}) },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: outcome === 'not_given' ? 'warning' : 'success',
        text: outcome === 'not_given'
          ? `Recorded as NOT given, with the reason. This stays on the record for the next clinician.`
          : `Administration recorded for ${target.name}.` });
      setTarget(null); setIdemKey(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was recorded — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not record the administration (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading medication round" />;
  if (state === 'error') return <StateBlock state="stale" title="Medication round unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Medication administration">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Medications due (MED-09)</h3>
        <StatusTag tone={meds.length > 0 ? 'neutral' : 'success'} icon={meds.length > 0 ? null : 'check'}>
          {meds.length > 0 ? `${meds.length} active` : 'None due'}
        </StatusTag>
      </div>

      {meds.length === 0
        ? <StateBlock state="empty" title="No medications due">There are no active medication requests to administer.</StateBlock>
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="mar-worklist">
              <caption className="sancta-visually-hidden">Active medication requests due for administration. Select record to enter a given or not-given outcome.</caption>
              <thead><tr><th scope="col">Patient</th><th scope="col">Clinic no.</th><th scope="col">Medicine</th><th scope="col">Dose</th><th scope="col">Route</th><th scope="col">Frequency</th><th scope="col"></th></tr></thead>
              <tbody>
                {meds.map((m) => (
                  <tr key={m.requestId} data-selected={target?.requestId === m.requestId || undefined}>
                    <td>{m.name}</td>
                    <td data-numeric>{m.mrn ?? '—'}</td>
                    <td>{m.medicineCode}</td>
                    <td>{m.dose ?? '—'}</td>
                    <td>{m.route ?? '—'}</td>
                    <td>{m.frequency ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}><Button variant="primary" density="compact" data-testid="mar-record" onClick={() => choose(m)}>Record</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {target && (
        <div className="scr__card" data-testid="mar-panel">
          <h3 className="scr__section-title">Administer — {target.name} · {target.medicineCode}</h3>
          <p className="scr__kpi-meta">{target.dose ?? 'dose per order'}{target.route ? ` · ${target.route}` : ''}{target.frequency ? ` · ${target.frequency}` : ''}</p>

          <div className="scr__seg" role="radiogroup" aria-label="Administration outcome" style={{ marginTop: 'var(--sancta-space-2)' }}>
            <button role="radio" aria-checked={outcome === 'given'} data-testid="mar-given" className="scr__seg-btn sancta-focusable" data-active={outcome === 'given'} onClick={() => setOutcome('given')}>Given</button>
            <button role="radio" aria-checked={outcome === 'not_given'} data-testid="mar-not-given" className="scr__seg-btn sancta-focusable" data-active={outcome === 'not_given'} onClick={() => setOutcome('not_given')}>Not given</button>
          </div>

          {outcome === 'not_given' && (
            <div style={{ marginTop: 'var(--sancta-space-3)' }}>
              <Banner tone="warning" title="A withheld dose must say why">Refused, held clinically, or unavailable — record the reason so the next clinician sees it.</Banner>
              <div style={{ marginTop: 'var(--sancta-space-2)' }}>
                <Field label="Reason not given" hint="Required" data-testid="mar-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
              </div>
            </div>
          )}

          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" tone={outcome === 'not_given' ? 'danger' : 'action'} data-testid="mar-submit" disabled={busy}
              {...(notGivenNeedsReason ? { disabledReason: 'A not-given dose requires a reason' } : {})}
              onClick={record}>{outcome === 'not_given' ? 'Record not given' : 'Record given'}</Button>
            <Button variant="subtle" data-testid="mar-cancel" disabled={busy} onClick={() => { setTarget(null); setMsg(null); }}>Cancel</Button>
          </div>
          {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
        </div>
      )}
      {!target && msg && <div data-testid="mar-result"><Banner tone={msg.tone}>{msg.text}</Banner></div>}
    </section>
  );
}
