import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const EXPORTED_BY = 'demo-operator';

type AuditRow = {
  id: string;
  actorUser: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  patientRef: string | null;
  outcome: string;
  reason: string | null;
  capturedAt: string;
};

type Filter = { user?: string; action?: string; resourceType?: string };

const OUTCOME_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = { success: 'success', failure: 'danger', denied: 'warning' };

function toQuery(f: Filter): string {
  const params = new URLSearchParams();
  if (f.user?.trim()) params.set('user', f.user.trim());
  if (f.action?.trim()) params.set('action', f.action.trim());
  if (f.resourceType?.trim()) params.set('resourceType', f.resourceType.trim());
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Audit-event log viewer (ADM-004, BR-012). Audit events are append-only and
 * immutable; this screen only reads and (as an audited action) exports them.
 * Search is by actor, action and resource-type — safe string filters, never a
 * patient identifier. Crucially the viewer NEVER reveals patient references or
 * resource ids in the clear: a row shows who did what to which resource TYPE, the
 * outcome and the time only, with a "patient-linked" marker where a record is
 * involved — so browsing the trail cannot itself leak PHI. Export is a control
 * event: it is confirmed explicitly and is itself recorded as an audit event, so
 * who exported what is always on the record. Reads /api/audit/search on open with
 * no filter (a safe, non-uuid query present on both the edge and the Worker).
 */
export function AuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [user, setUser] = useState('');
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const filter = (): Filter => ({ user, action, resourceType });

  const search = useCallback(async (f: Filter) => {
    const r = await jsonFetch<{ events?: AuditRow[]; rows?: AuditRow[] }>(`/api/audit/search${toQuery(f)}`);
    setRows(r.events ?? r.rows ?? []);
  }, []);

  useEffect(() => {
    setState('loading');
    void (async () => { try { await search({}); setState('ready'); } catch { setState('error'); } })();
  }, [search]);

  const runSearch = async () => {
    setBusy(true); setMsg(null);
    try { await search(filter()); setState('ready'); } catch { setState('error'); }
    finally { setBusy(false); }
  };

  const doExport = async () => {
    setBusy(true); setMsg(null);
    const res = await mutate<{ rows: AuditRow[]; exportEventId: string }>(
      '/api/audit/export',
      { filter: filter(), exportedBy: EXPORTED_BY },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false); setConfirmExport(false);
    if (res.ok && res.data?.exportEventId) {
      setMsg({ tone: 'success', text: `Exported ${res.data.rows.length} audit rows. This export was itself recorded — event ···${res.data.exportEventId.slice(-8)}.` });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing was exported. Retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not export the audit trail (${res.errorCode ?? 'error'}).` });
    }
  };

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading audit trail" />;
  if (state === 'error') return <StateBlock state="stale" title="Audit trail unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label="Audit event log">
      <div className="scr__card" data-testid="audit-filters">
        <h3 className="scr__section-title">Search the audit trail (ADM-04)</h3>
        <p className="scr__kpi-meta">Filter by actor, action or resource type. Patient references are never shown or searchable here — the trail records who did what, not the patient in the clear.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Actor" optional hint="e.g. a staff username" data-testid="audit-user" value={user} onChange={(e) => setUser(e.currentTarget.value)} />
          <Field label="Action" optional hint="e.g. sign, export, config" data-testid="audit-action" value={action} onChange={(e) => setAction(e.currentTarget.value)} />
          <Field label="Resource type" optional hint="e.g. encounter, config_release" data-testid="audit-resource" value={resourceType} onChange={(e) => setResourceType(e.currentTarget.value)} />
          <Button variant="primary" data-testid="audit-search-btn" disabled={busy} icon={<Icon name="info" />} onClick={runSearch}>Search</Button>
          <Button variant="secondary" data-testid="audit-export-btn" disabled={busy} {...(rows.length === 0 ? { disabledReason: 'Nothing to export for this filter' } : {})} onClick={() => setConfirmExport(true)}>Export</Button>
        </div>
      </div>

      {confirmExport && (
        <div className="scr__card" data-testid="audit-export-confirm">
          <Banner tone="warning" title="Export this audit trail?" assertive>
            Exporting audit data is itself an audited action — a record of who exported what, and when, will be written to the trail. It will export the rows matching the current filter.
          </Banner>
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" data-testid="audit-export-confirm-btn" disabled={busy} onClick={doExport}>Export and record</Button>
            <Button variant="subtle" data-testid="audit-export-cancel" disabled={busy} onClick={() => setConfirmExport(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {msg && <Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner>}

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Events</h3>
          <StatusTag tone="neutral">{`${rows.length} shown`}</StatusTag>
        </div>
        {rows.length === 0
          ? <StateBlock state="empty" title="No matching events" />
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="audit-list">
                <caption className="sancta-visually-hidden">Audit events: actor, action, resource type, outcome and time. Patient references are masked.</caption>
                <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Resource</th><th scope="col">Outcome</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td data-numeric>{r.capturedAt.replace('T', ' ').slice(0, 19)}</td>
                      <td>{r.actorUser ?? 'system'}</td>
                      <td>{r.action}</td>
                      <td>
                        {r.resourceType}
                        {r.patientRef && <span style={{ marginLeft: 'var(--sancta-space-2)' }}><StatusTag tone="neutral" icon="linked">patient-linked</StatusTag></span>}
                      </td>
                      <td><StatusTag tone={OUTCOME_TONE[r.outcome] ?? 'neutral'} icon={r.outcome === 'success' ? 'check' : r.outcome === 'failure' ? 'alert' : null}>{r.outcome}</StatusTag></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </section>
  );
}
