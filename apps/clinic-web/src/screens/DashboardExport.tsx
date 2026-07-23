import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Kpi = { id: string; label: string; value: number; unit: string; owner: string; formula: string };
type ExceptionRow = { type: string; label: string; count: number; queue: string; owner: string };
type ManagementExport = {
  asOf: string; filters: Record<string, string>; confidentiality: string; exportedBy: string; format: string;
  dashboard: { asOf: string; kpis: Kpi[]; exceptions: ExceptionRow[] };
};
type Commentary = {
  id: string; kpiId: string; period: string; commentary: string; action: string | null;
  actionOwner: string | null; dueDate: string | null; status: string; authoredBy: string | null; authoredAt: string;
};

type Format = 'json' | 'csv' | 'pdf';
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Management pack export + KPI commentary (MGT-007/010). Exporting a management pack
 * is an `export`-gated, audited control event — the envelope carries the as-of time,
 * an owner and a confidentiality label, and patient-level detail is deliberately
 * excluded. The commentary log is append-only (MGT-010): a manager records why a
 * number moved and the corrective action, and prior notes are never overwritten. The
 * export uses the §9.2 confirmed-commit contract; commentary reads are scoped by KPI
 * id + period strings (no unsafe uuid-on-mount read).
 */
export function DashboardExport() {
  // Export intent.
  const [asOf, setAsOf] = useState(today());
  const [exportedBy, setExportedBy] = useState('');
  const [format, setFormat] = useState<Format>('json');
  const [exportKey, setExportKey] = useState(newIdempotencyKey());
  const [envelope, setEnvelope] = useState<ManagementExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  // Commentary intent.
  const [kpiId, setKpiId] = useState('');
  const [period, setPeriod] = useState('');
  const [notes, setNotes] = useState<Commentary[] | null>(null);
  const [notesState, setNotesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [text, setText] = useState('');
  const [action, setAction] = useState('');
  const [actionOwner, setActionOwner] = useState('');
  const [noteKey, setNoteKey] = useState(newIdempotencyKey());
  const [noteMsg, setNoteMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const runExport = async () => {
    if (!exportedBy.trim()) return;
    setBusy(true); setExportMsg(null);
    const res = await mutate<ManagementExport>('/api/management/export',
      { asOf, exportedBy: exportedBy.trim(), format }, { idempotencyKey: exportKey });
    setBusy(false);
    if (res.ok && res.data) {
      setEnvelope(res.data);
      setExportMsg({ tone: 'success', text: `Management pack generated as ${res.data.format.toUpperCase()} — ${res.data.confidentiality}. The export was recorded to the audit trail.` });
      setExportKey(newIdempotencyKey());
    } else if (res.status === 403) {
      setExportMsg({ tone: 'danger', text: 'You do not have permission to export the management pack. Nothing was exported.' });
    } else if (res.errorCode === 'network') {
      setExportMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was exported — retry when connected.' });
    } else {
      setExportMsg({ tone: 'danger', text: `Export blocked (${res.errorMessage ?? res.errorCode ?? 'error'}).` });
    }
  };

  const canLoadNotes = !!kpiId.trim() && !!period.trim();
  const loadNotes = async () => {
    if (!canLoadNotes) return;
    setNotesState('loading'); setNoteMsg(null);
    try {
      const r = await jsonFetch<{ commentary: Commentary[] }>(`/api/management/commentary?kpiId=${encodeURIComponent(kpiId.trim())}&period=${encodeURIComponent(period.trim())}`);
      setNotes(r.commentary); setNotesState('ready'); setNoteKey(newIdempotencyKey());
    } catch { setNotesState('error'); }
  };

  const addNote = async () => {
    if (!canLoadNotes || !text.trim()) return;
    setBusy(true); setNoteMsg(null);
    const body: Record<string, string> = { kpiId: kpiId.trim(), period: period.trim(), commentary: text.trim() };
    if (action.trim()) body.action = action.trim();
    if (actionOwner.trim()) body.actionOwner = actionOwner.trim();
    const res = await mutate<{ id: string }>('/api/management/commentary', body, { idempotencyKey: noteKey });
    setBusy(false);
    if (res.ok) {
      setNoteMsg({ tone: 'success', text: 'Commentary recorded (append-only) against this KPI period.' });
      setText(''); setAction(''); setActionOwner('');
      try { await loadNotes(); } catch { /* covered by state */ }
    } else if (res.status === 403) {
      setNoteMsg({ tone: 'danger', text: 'You do not have permission to record commentary. Your note is kept.' });
    } else if (res.errorCode === 'network') {
      setNoteMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was saved — your note is kept; retry when connected.' });
    } else {
      setNoteMsg({ tone: 'danger', text: `Commentary rejected (${res.errorMessage ?? res.errorCode ?? 'error'}). Your note is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Management pack export and commentary">
      <div className="scr__card" data-testid="mx-export">
        <h3 className="scr__section-title">Export management pack</h3>
        <div className="scr__row" style={{ alignItems: 'flex-end' }}>
          <Field label="As of" type="date" data-testid="mx-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} style={{ maxWidth: 200 }} />
          <Field label="Exported by" hint="Recorded on the audit trail" data-testid="mx-by" value={exportedBy} onChange={(e) => setExportedBy(e.currentTarget.value)} style={{ minWidth: 220 }} />
          <label className="sancta-field" style={{ maxWidth: 160 }}>
            <span className="sancta-field__label">Format</span>
            <select className="sancta-field-input" data-testid="mx-format" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
              <option value="json">JSON</option><option value="csv">CSV</option><option value="pdf">PDF</option>
            </select>
          </label>
          <Button variant="primary" data-testid="mx-export-submit" disabled={busy}
            {...(exportedBy.trim() ? {} : { disabledReason: 'Enter who is exporting (recorded on the audit trail)' })}
            onClick={runExport}>Export pack</Button>
        </div>
        {exportMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={exportMsg.tone} assertive={exportMsg.tone === 'danger'}>{exportMsg.text}</Banner></div>}

        {envelope && (
          <div data-testid="mx-envelope" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
              <StatusTag tone="neutral" icon="lock">{envelope.confidentiality}</StatusTag>
              <span className="scr__kpi-meta">{`as-of ${envelope.asOf} · by ${envelope.exportedBy} · ${envelope.format.toUpperCase()}`}</span>
            </div>
            <div className="scr__kpi-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
              <div className="scr__kpi"><span className="scr__kpi-label">KPIs in pack</span><span className="scr__kpi-value">{envelope.dashboard.kpis.length}</span><span className="scr__kpi-meta">Aggregate indicators</span></div>
              <div className="scr__kpi"><span className="scr__kpi-label">Open exceptions</span><span className="scr__kpi-value">{envelope.dashboard.exceptions.length}</span><span className="scr__kpi-meta">Needing attention</span></div>
            </div>
            {envelope.dashboard.kpis.length > 0 && (
              <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
                <table className="scr__table">
                  <caption className="sancta-visually-hidden">KPIs included in the exported pack</caption>
                  <thead><tr><th scope="col">Indicator</th><th scope="col">Owner</th><th scope="col" style={{ textAlign: 'right' }}>Value</th></tr></thead>
                  <tbody>
                    {envelope.dashboard.kpis.map((k) => (
                      <tr key={k.id}><td>{k.label}</td><td>{k.owner}</td><td data-numeric style={{ textAlign: 'right' }}>{k.value} {k.unit}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="scr__card" data-testid="mx-commentary" style={{ marginTop: 'var(--sancta-space-4)' }}>
        <h3 className="scr__section-title">KPI commentary log</h3>
        <div className="scr__row" style={{ alignItems: 'flex-end' }}>
          <Field label="KPI id" hint="The indicator to annotate" data-testid="mx-kpi" value={kpiId} onChange={(e) => setKpiId(e.currentTarget.value)} style={{ maxWidth: 220 }} />
          <Field label="Period" hint="e.g. 2026-07" data-testid="mx-period" value={period} onChange={(e) => setPeriod(e.currentTarget.value)} style={{ maxWidth: 180 }} />
          <Button variant="primary" data-testid="mx-notes-load"
            {...(canLoadNotes ? {} : { disabledReason: 'Enter a KPI id and period' })}
            onClick={loadNotes}>Load notes</Button>
        </div>

        {notesState === 'loading' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="initial-loading" title="Loading commentary" /></div>}
        {notesState === 'error' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="stale" title="Commentary unavailable">The clinic hub may be unreachable.</StateBlock></div>}

        {notesState === 'ready' && notes && (
          <>
            {notes.length === 0
              ? <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="empty" title="No commentary yet for this KPI period">Add the first note below.</StateBlock></div>
              : (
                <ul className="scr__list" style={{ marginTop: 'var(--sancta-space-3)' }} data-testid="mx-notes">
                  {notes.map((n) => (
                    <li key={n.id}>
                      <div className="scr__list-btn" style={{ display: 'block', cursor: 'default' }}>
                        <div style={{ display: 'flex', gap: 'var(--sancta-space-3)', alignItems: 'center' }}>
                          <StatusTag tone="neutral">{n.status}</StatusTag>
                          <span style={{ flex: 1 }}>{n.commentary}</span>
                          <span className="scr__kpi-meta">{(n.authoredBy ?? 'unknown')} · {n.authoredAt.slice(0, 16).replace('T', ' ')}</span>
                        </div>
                        {n.action && <div className="scr__kpi-meta" style={{ marginTop: 'var(--sancta-space-2)' }}>Action: {n.action}{n.actionOwner ? ` (${n.actionOwner})` : ''}{n.dueDate ? ` — due ${n.dueDate}` : ''}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

            <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-3)' }}>
              <Field label="Commentary" hint="Why the number moved" data-testid="mx-note-text" value={text} onChange={(e) => setText(e.currentTarget.value)} style={{ minWidth: 280 }} />
              <Field label="Corrective action" optional data-testid="mx-note-action" value={action} onChange={(e) => setAction(e.currentTarget.value)} style={{ minWidth: 220 }} />
              <Field label="Action owner" optional data-testid="mx-note-owner" value={actionOwner} onChange={(e) => setActionOwner(e.currentTarget.value)} style={{ maxWidth: 200 }} />
              <Button variant="primary" data-testid="mx-note-add" disabled={busy}
                {...(text.trim() ? {} : { disabledReason: 'Enter the commentary text' })}
                onClick={addNote}>Add note</Button>
            </div>
            {noteMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={noteMsg.tone} assertive={noteMsg.tone === 'danger'}>{noteMsg.text}</Banner></div>}
          </>
        )}
      </div>
    </section>
  );
}
