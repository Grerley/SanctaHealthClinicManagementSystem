import { useState } from 'react';
import { Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type DiagnosisCode = { system: string; code: string; display: string };

/**
 * Coded diagnosis lookup (EHR-005). An offline search over the local diagnosis-code
 * table so a clinician can find the exact coded term to attach to an encounter's
 * assessment — the same catalogue the encounter recorder resolves against. Read-only
 * reference: it never mutates the record (a diagnosis is recorded against a specific
 * encounter from the encounter workflow), it just resolves free text to a coded term.
 * Uses GET /api/ehr/diagnosis-codes?q — the same path and method on both the edge and
 * the Worker; the read takes a plain search term, no patient scope.
 */
export function DiagnosisLookup() {
  const [q, setQ] = useState('');
  const [codes, setCodes] = useState<DiagnosisCode[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const search = async () => {
    if (!q.trim()) return;
    setState('loading');
    try {
      const r = await jsonFetch<{ codes: DiagnosisCode[] }>(`/api/ehr/diagnosis-codes?q=${encodeURIComponent(q.trim())}`);
      setCodes(r.codes);
      setState('ready');
    } catch { setState('error'); }
  };

  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter') void search(); };

  return (
    <section className="scr" aria-label="Diagnosis code lookup">
      <div className="scr__card" data-testid="dx-search">
        <h3 className="scr__section-title">Diagnosis code lookup (EHR-05)</h3>
        <p className="scr__kpi-meta">Search the offline diagnosis-code catalogue by code or term.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }} onKeyDown={onKeyDown}>
          <Field label="Search" hint="e.g. diabetes, I10, hypertension" data-testid="dx-q" value={q} onChange={(e) => setQ(e.currentTarget.value)} style={{ minWidth: 280 }} />
          <Button variant="primary" data-testid="dx-search-btn" disabled={state === 'loading'} {...(!q.trim() ? { disabledReason: 'Enter a code or term to search' } : {})} onClick={search}>Search</Button>
        </div>
      </div>

      {state === 'idle' && <StateBlock state="empty" title="Search the diagnosis catalogue">Enter a code or term above to find a coded diagnosis.</StateBlock>}
      {state === 'loading' && <StateBlock state="initial-loading" title="Searching codes" />}
      {state === 'error' && <StateBlock state="stale" title="Lookup unavailable">The clinic hub may be unreachable.</StateBlock>}
      {state === 'ready' && (
        codes.length === 0
          ? <StateBlock state="filtered-empty" title="No matching codes">No diagnosis code matched that term. Try a broader search.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="dx-results">
                <caption className="sancta-visually-hidden">Diagnosis codes matching the search, by code</caption>
                <thead><tr><th scope="col">Code</th><th scope="col">System</th><th scope="col">Term</th></tr></thead>
                <tbody>
                  {codes.map((c) => (
                    <tr key={`${c.system}-${c.code}`}>
                      <td data-numeric><StatusTag tone="info">{c.code}</StatusTag></td>
                      <td>{c.system}</td>
                      <td>{c.display}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}
    </section>
  );
}
