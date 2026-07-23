import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type ChecklistItem = { key: string; label: string; required?: boolean };

/** Parse "key | label | required" lines into checklist items. A line's first field is
 * the key; the second (optional) is the human label; a third field marked yes/true/*
 * flags the item required. */
function parseItems(text: string): ChecklistItem[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split('|').map((p) => p.trim());
    const key = parts[0] ?? '';
    const label = parts[1] && parts[1] !== '' ? parts[1] : key;
    const req = (parts[2] ?? '').toLowerCase();
    const required = req === 'yes' || req === 'y' || req === 'true' || req === 'required' || req === '*';
    return required ? { key, label, required: true } : { key, label };
  }).filter((i) => i.key !== '');
}

/** Parse "key = value" lines into a results record. A bare "key" records a truthy tick. */
function parseResults(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq === -1) { out[line] = true; continue; }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key !== '') out[key] = value === '' ? true : value;
  }
  return out;
}

/**
 * Facility safety checklists (OPS-004). Two write-only workflows: define (or update)
 * a checklist template with its items, and record a run of a template. A run is stored
 * even when partial; the hub returns which REQUIRED items were missed so the operator
 * can see the run is incomplete. Both are confirmed-commit; the draft is kept on
 * failure.
 */
export function FacilityChecklists() {
  // Define draft.
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [defKind, setDefKind] = useState('');
  const [itemsText, setItemsText] = useState('');
  const [defIdem, setDefIdem] = useState(newIdempotencyKey());
  const [defining, setDefining] = useState(false);
  const [defMsg, setDefMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Run draft.
  const [templateCode, setTemplateCode] = useState('');
  const [resultsText, setResultsText] = useState('');
  const [runNotes, setRunNotes] = useState('');
  const [runIdem, setRunIdem] = useState(newIdempotencyKey());
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);

  const parsedItems = parseItems(itemsText);

  const define = async () => {
    if (code.trim() === '' || name.trim() === '' || defKind.trim() === '' || parsedItems.length === 0) return;
    setDefining(true); setDefMsg(null);
    const res = await mutate<{ code: string }>(
      '/api/facility/checklist',
      { code: code.trim(), name: name.trim(), kind: defKind.trim(), items: parsedItems },
      { idempotencyKey: defIdem },
    );
    setDefining(false);
    if (res.ok && res.data?.code) {
      setDefMsg({ tone: 'success', text: `Saved checklist ${res.data.code} with ${parsedItems.length} item${parsedItems.length === 1 ? '' : 's'}.` });
      setDefIdem(newIdempotencyKey());
      if (templateCode.trim() === '') setTemplateCode(code.trim());
    } else if (res.errorCode === 'network') {
      setDefMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was saved — your entry is kept; retry when connected.' });
    } else {
      setDefMsg({ tone: 'danger', text: `Could not save the checklist (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const run = async () => {
    if (templateCode.trim() === '') return;
    setRunning(true); setRunMsg(null);
    const res = await mutate<{ runId: string; complete: boolean; missing: string[] }>(
      '/api/facility/checklist/run',
      {
        templateCode: templateCode.trim(),
        results: parseResults(resultsText),
        ...(runNotes.trim() ? { notes: runNotes.trim() } : {}),
      },
      { idempotencyKey: runIdem },
    );
    setRunning(false);
    if (res.ok && res.data) {
      const runId = res.data.runId;
      if (res.data.complete) {
        setRunMsg({ tone: 'success', text: `Recorded a complete run of ${templateCode.trim()}. Run id ···${runId.slice(-8)}.` });
      } else {
        const missing = res.data.missing ?? [];
        setRunMsg({ tone: 'warning', text: `Recorded an incomplete run of ${templateCode.trim()} (run id ···${runId.slice(-8)}). Missing required item${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || '—'}.` });
      }
      setResultsText(''); setRunNotes(''); setRunIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setRunMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was recorded — your entry is kept; retry when connected.' });
    } else {
      // e.g. "unknown checklist <code>".
      setRunMsg({ tone: 'danger', text: `Could not record the run (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Facility safety checklists" data-testid="facility-checklists">
      <div className="scr__card" data-testid="fac-chk-run-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Record a checklist run (OPS-004)</h3>
          <StatusTag tone="info" icon="info">{`${Object.keys(parseResults(resultsText)).length} answered`}</StatusTag>
        </div>
        <p className="scr__kpi-meta">Record a run of a defined checklist. A run is stored even when partial; the hub reports any required items that were missed.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Template code" hint="The checklist to run" data-testid="fac-chk-run-code" value={templateCode} onChange={(e) => setTemplateCode(e.currentTarget.value)} />
          <Field label="Notes" optional hint="Anything to record" data-testid="fac-chk-run-notes" value={runNotes} onChange={(e) => setRunNotes(e.currentTarget.value)} />
          <label className="sancta-field" style={{ gridColumn: '1 / -1' }}>
            <span className="sancta-field__label">Results</span>
            <span className="sancta-field__hint">One per line, "key = value"; a bare key records a tick.</span>
            <textarea className="sancta-field-input scr__textarea" data-testid="fac-chk-run-results" rows={4} value={resultsText} onChange={(e) => setResultsText(e.currentTarget.value)} />
          </label>
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="fac-chk-run-submit" disabled={running}
            {...(templateCode.trim() === '' ? { disabledReason: 'Enter the template code' } : {})}
            onClick={run}>Record run</Button>
        </div>
        {runMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={runMsg.tone} assertive={runMsg.tone === 'danger'}>{runMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="fac-chk-define-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Define a checklist</h3>
          <StatusTag tone={parsedItems.length > 0 ? 'success' : 'neutral'} icon={parsedItems.length > 0 ? 'check' : null}>{`${parsedItems.length} item${parsedItems.length === 1 ? '' : 's'}`}</StatusTag>
        </div>
        <p className="scr__kpi-meta">Create or update a checklist template. Re-using an existing code replaces its items.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Code" hint="Stable identifier, e.g. OT-DAILY" data-testid="fac-chk-def-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Name" hint="What the checklist is" data-testid="fac-chk-def-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Field label="Kind" hint="What it applies to, e.g. room" data-testid="fac-chk-def-kind" value={defKind} onChange={(e) => setDefKind(e.currentTarget.value)} />
          <label className="sancta-field" style={{ gridColumn: '1 / -1' }}>
            <span className="sancta-field__label">Items</span>
            <span className="sancta-field__hint">One per line, "key | label | required" (mark the third field yes to require it).</span>
            <textarea className="sancta-field-input scr__textarea" data-testid="fac-chk-def-items" rows={5} value={itemsText} onChange={(e) => setItemsText(e.currentTarget.value)} />
          </label>
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="fac-chk-def-submit" disabled={defining}
            {...(code.trim() === '' ? { disabledReason: 'Enter a code' } : name.trim() === '' ? { disabledReason: 'Enter a name' } : defKind.trim() === '' ? { disabledReason: 'Enter a kind' } : parsedItems.length === 0 ? { disabledReason: 'Add at least one item' } : {})}
            onClick={define}>Save checklist</Button>
        </div>
        {defMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={defMsg.tone} assertive={defMsg.tone === 'danger'}>{defMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
