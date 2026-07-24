import { useState } from 'react';
import { Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type FormularyItem = { sku: string; name: string; category: string | null; controlled: boolean; onHand: number };

/**
 * Formulary (MED-001). A read-only browse of the medication catalogue: search by name,
 * see category, controlled-drug status and on-hand stock. Controlled items are flagged
 * so they are visible at a glance.
 */
export function Formulary() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<FormularyItem[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const search = async () => {
    setState('loading');
    try { const r = await jsonFetch<{ items: FormularyItem[] }>(`/api/formulary?q=${encodeURIComponent(q.trim())}`); setItems(r.items); setState('ready'); }
    catch { setState('error'); }
  };

  return (
    <section className="scr" aria-label="Formulary">
      <div>
        <div className="scr__toolbar">
          <h3 className="scr__section-title">Medication formulary</h3>
          <Field label="Search" hideLabel hint="Name or code" data-testid="formulary-q" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          <Button variant="primary" icon={<Icon name="sync" />} data-testid="formulary-go" disabled={state === 'loading'} onClick={search}>Search</Button>
        </div>
        {state === 'idle' && <StateBlock state="empty" title="Search the formulary">Enter a name or code and search.</StateBlock>}
        {state === 'loading' && <StateBlock state="initial-loading" title="Searching" />}
        {state === 'error' && <StateBlock state="stale" title="Formulary unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          items.length === 0
            ? <StateBlock state="empty" title="No matches">No formulary items match that search.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="formulary-items">
                  <caption className="sancta-visually-hidden">Formulary items matching the search</caption>
                  <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Category</th><th scope="col">Class</th><th scope="col">On hand</th></tr></thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={it.sku}>
                        <td data-numeric>{it.sku}</td>
                        <td>{it.name}</td>
                        <td>{it.category ?? '—'}</td>
                        <td><StatusTag tone={it.controlled ? 'danger' : 'neutral'} icon={it.controlled ? 'alert' : null}>{it.controlled ? 'Controlled' : 'Standard'}</StatusTag></td>
                        <td data-numeric>{`${it.onHand}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
    </section>
  );
}
