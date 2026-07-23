import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type Patient, type HistoryItem } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const USER = 'demo-operator';

// Server-validated set (clinical.history_item categories, EHR-004). 'allergy' is
// safety-critical: an allergy captured here is a clinical record and is surfaced
// prominently — it is never treated as an ordinary problem.
const CATEGORIES = [
  { value: 'problem', label: 'Active problem' },
  { value: 'past_medical', label: 'Past medical' },
  { value: 'surgical', label: 'Surgical' },
  { value: 'family', label: 'Family history' },
  { value: 'social', label: 'Social history' },
  { value: 'immunisation', label: 'Immunisation' },
  { value: 'allergy', label: 'Allergy' },
] as const;
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));
const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning'> = { active: 'warning', resolved: 'success', inactive: 'neutral' };
const NEXT_STATUS = ['active', 'resolved', 'inactive'] as const;

/**
 * Problem & clinical history list (EHR-004). The longitudinal, coded problem list for
 * the patient in context — active problems, past medical/surgical, family and social
 * history, immunisations and recorded allergies. Every entry has a status you can
 * revise (active → resolved/inactive) so the list stays current without ever deleting
 * clinical history. Uses GET /api/ehr/history?patientId, POST /api/ehr/history and
 * POST /api/ehr/history/status — matching paths on both the edge and the Worker; the
 * read is scoped to the patient's own UUID, so it fetches only with a patient in
 * context. Writes are confirmed-commit (§9.2) and preserve the draft on failure; an
 * allergy entry is explicit (its own category) and is never silently dropped.
 */
export function ProblemList({ patient }: { patient: Patient | null }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const [category, setCategory] = useState<string>('problem');
  const [detail, setDetail] = useState('');
  const [code, setCode] = useState('');
  const [onsetDate, setOnsetDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!patient) return;
    const r = await api.ehrHistory(patient.id);
    setItems(r.history);
  }, [patient]);

  useEffect(() => {
    if (!patient) { setState('idle'); return; }
    setState('loading');
    void (async () => { try { await load(); setState('ready'); } catch { setState('error'); } })();
  }, [patient, load]);

  if (!patient) {
    return <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to view or add to their problem list.</StateBlock>;
  }
  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading problem list" />;
  if (state === 'error') return <StateBlock state="stale" title="Problem list unavailable">The clinic hub may be unreachable.</StateBlock>;

  const addItem = async () => {
    if (!detail.trim()) return;
    setBusy(true); setMsg(null);
    const body = {
      patientId: patient.id,
      category,
      detail: detail.trim(),
      ...(code.trim() ? { code: code.trim() } : {}),
      ...(onsetDate ? { onsetDate } : {}),
      user: USER,
    };
    const res = await mutate<{ id: string }>('/api/ehr/history', body, { idempotencyKey: newIdempotencyKey() });
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `${CATEGORY_LABEL[category]} recorded.` });
      setDetail(''); setCode(''); setOnsetDate('');
      try { await load(); } catch { /* connectivity indicator covers this */ }
      return;
    }
    setMsg({ tone: 'danger', text: res.errorCode === 'network'
      ? 'Could not reach the clinic hub — nothing was saved; your entry is kept.'
      : `Could not save (${res.errorCode ?? 'error'}). Your entry is kept.` });
  };

  const setStatus = async (item: HistoryItem, status: string) => {
    setBusyId(item.id); setMsg(null);
    const res = await mutate<{ id: string; status: string }>('/api/ehr/history/status', { id: item.id, status }, { idempotencyKey: newIdempotencyKey() });
    setBusyId(null);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Marked ${status}.` });
      try { await load(); } catch { /* connectivity indicator covers this */ }
      return;
    }
    setMsg({ tone: 'danger', text: res.errorCode === 'network'
      ? 'Could not reach the clinic hub — the status is unchanged.'
      : `Could not update status (${res.errorCode ?? 'error'}).` });
  };

  const allergies = items.filter((h) => h.category === 'allergy');
  const clinical = items.filter((h) => h.category !== 'allergy');

  const row = (h: HistoryItem) => {
    const nextIdx = (NEXT_STATUS.indexOf(h.status as typeof NEXT_STATUS[number]) + 1) % NEXT_STATUS.length;
    const next: string = NEXT_STATUS[nextIdx] ?? 'active';
    return (
      <tr key={h.id}>
        <td>{CATEGORY_LABEL[h.category] ?? h.category}</td>
        <td>{h.detail}{h.code ? <> <StatusTag tone="neutral">{h.code}</StatusTag></> : null}</td>
        <td data-numeric>{h.onsetDate ?? '—'}</td>
        <td><StatusTag tone={STATUS_TONE[h.status] ?? 'neutral'}>{h.status}</StatusTag></td>
        <td style={{ textAlign: 'right' }}>
          <Button variant="subtle" density="compact" data-testid="pl-status" disabled={busyId === h.id} onClick={() => setStatus(h, next)}>Mark {next}</Button>
        </td>
      </tr>
    );
  };

  return (
    <section className="scr" aria-label={`Problem list for ${patient.given_name} ${patient.family_name}`}>
      <div className="scr__card" data-testid="pl-add">
        <h3 className="scr__section-title">Add to problem list (EHR-04)</h3>
        <p className="scr__kpi-meta">For {patient.given_name} {patient.family_name}.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <label className="sancta-field">
            <span className="sancta-field__label">Category</span>
            <select className="sancta-field-input" data-testid="pl-category" value={category} onChange={(e) => setCategory(e.currentTarget.value)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <Field label="Detail" hint="e.g. Type 2 diabetes; penicillin rash" data-testid="pl-detail" value={detail} onChange={(e) => setDetail(e.currentTarget.value)} />
          <Field label="Code" optional hint="Diagnosis / substance code" data-testid="pl-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Onset" optional type="date" data-testid="pl-onset" value={onsetDate} onChange={(e) => setOnsetDate(e.currentTarget.value)} />
        </div>
        {category === 'allergy' && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Banner tone="warning" title="Allergy entry">This records an allergy in the clinical record. To make it gate prescribing with a coded substance and severity, also capture it on the Allergies screen.</Banner>
          </div>
        )}
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="pl-add-btn" disabled={busy} {...(!detail.trim() ? { disabledReason: 'Enter the detail' } : {})} onClick={addItem}>Add entry</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      {allergies.length > 0 && (
        <div>
          <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
            <h3 className="scr__section-title">Recorded allergies</h3>
            <StatusTag tone="danger" icon="alert">{`${allergies.length} on record`}</StatusTag>
          </div>
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="pl-allergies">
              <caption className="sancta-visually-hidden">Allergies recorded in the clinical history</caption>
              <thead><tr><th scope="col">Category</th><th scope="col">Detail</th><th scope="col">Onset</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
              <tbody>{allergies.map(row)}</tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <h3 className="scr__section-title">Problems & history</h3>
        {clinical.length === 0
          ? <StateBlock state="empty" title="No history recorded yet">Add the first entry above.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="pl-table">
                <caption className="sancta-visually-hidden">Problem list and clinical history, grouped by category</caption>
                <thead><tr><th scope="col">Category</th><th scope="col">Detail</th><th scope="col">Onset</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
                <tbody>{clinical.map(row)}</tbody>
              </table>
            </div>
          )}
      </div>
    </section>
  );
}
