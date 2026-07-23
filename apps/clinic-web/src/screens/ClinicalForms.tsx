import { useEffect, useState } from 'react';
import { StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type FormField = { key: string; label: string; type: string; required?: boolean; options?: readonly string[] };
type FormDefinition = { formCode: string; version: number; title: string; fields: FormField[]; effectiveFrom: string; effectiveTo?: string; active?: boolean };

/**
 * Clinical forms catalogue (EHR-003). The structured, versioned clinical forms in
 * force today — each with the exact fields (and which are required) that an encounter
 * captures and validates against. Forms are effective-dated reference data: this lists
 * the version currently in force so a clinician sees precisely what will be recorded.
 * Read-only here by design — a signed, effective-dated form definition is authored
 * under a separate configuration permission and must not be presented as editable from
 * the clinical desk. Uses GET /api/forms — the same path and method on both the edge
 * and the Worker; the read takes no patient scope (a facility-wide catalogue).
 */
export function ClinicalForms() {
  const [forms, setForms] = useState<FormDefinition[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    setState('loading');
    void (async () => {
      try {
        const r = await jsonFetch<{ forms: FormDefinition[] }>('/api/forms');
        setForms(r.forms);
        setState('ready');
      } catch { setState('error'); }
    })();
  }, []);

  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading clinical forms" />;
  if (state === 'error') return <StateBlock state="stale" title="Forms unavailable">The clinic hub may be unreachable.</StateBlock>;
  if (forms.length === 0) {
    return <StateBlock state="empty" title="No forms in force">No clinical form version is effective today.</StateBlock>;
  }

  return (
    <section className="scr" aria-label="Clinical forms catalogue">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Clinical forms in force (EHR-03)</h3>
          <StatusTag tone="info">{`${forms.length} form${forms.length === 1 ? '' : 's'}`}</StatusTag>
        </div>
        <p className="scr__kpi-meta">The version of each form effective today. An encounter validates its content against these fields.</p>
      </div>

      {forms.map((f) => (
        <div key={`${f.formCode}-${f.version}`} className="scr__card" data-testid="cfm-form">
          <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
            <h3 className="scr__section-title">{f.title}</h3>
            <span className="scr__row" style={{ gap: 'var(--sancta-space-2)' }}>
              <StatusTag tone="neutral">{f.formCode}</StatusTag>
              <StatusTag tone="info">{`v${f.version}`}</StatusTag>
              {f.active === false ? <StatusTag tone="warning">inactive</StatusTag> : null}
            </span>
          </div>
          <p className="scr__kpi-meta">
            Effective {f.effectiveFrom}{f.effectiveTo ? ` until ${f.effectiveTo}` : ' (open-ended)'}.
          </p>
          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-2)' }}>
            <table className="scr__table" data-testid="cfm-fields">
              <caption className="sancta-visually-hidden">{`Fields captured by ${f.title}`}</caption>
              <thead><tr><th scope="col">Field</th><th scope="col">Key</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Options</th></tr></thead>
              <tbody>
                {f.fields.map((fld) => (
                  <tr key={fld.key}>
                    <td>{fld.label}</td>
                    <td data-numeric>{fld.key}</td>
                    <td>{fld.type}</td>
                    <td>{fld.required ? <StatusTag tone="warning">Required</StatusTag> : <StatusTag tone="neutral">Optional</StatusTag>}</td>
                    <td>{fld.options && fld.options.length > 0 ? fld.options.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
