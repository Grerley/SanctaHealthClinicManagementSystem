import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type DimValue = { valueCode: string; label: string; active: boolean };
type Dimension = { code: string; name: string; values: DimValue[] };

/**
 * Reporting dimensions (FIN-001). A dimension is a controlled analysis axis (e.g.
 * service line, funder) with an enumerated value set — reference data governed as
 * configuration and audited. The list is a plain read (no uuid scope), safe on
 * mount and re-query. Two writes register a new dimension and add a value to an
 * existing one; both are §9.2 confirmed-commit writes (idempotency key per intent,
 * draft kept on failure) and the list reloads only after the hub accepts them.
 */
export function FinanceDimensions() {
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // New dimension draft.
  const [dimCode, setDimCode] = useState('');
  const [dimName, setDimName] = useState('');
  const [dimIdem, setDimIdem] = useState(newIdempotencyKey());
  const [dimBusy, setDimBusy] = useState(false);
  const [dimMsg, setDimMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // New value draft.
  const [valDim, setValDim] = useState('');
  const [valCode, setValCode] = useState('');
  const [valLabel, setValLabel] = useState('');
  const [valIdem, setValIdem] = useState(newIdempotencyKey());
  const [valBusy, setValBusy] = useState(false);
  const [valMsg, setValMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const r = await jsonFetch<{ dimensions: Dimension[] }>('/api/finance/dimensions');
      setDimensions(r.dimensions); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createDimension = async () => {
    if (dimCode.trim() === '' || dimName.trim() === '') return;
    setDimBusy(true); setDimMsg(null);
    const res = await mutate<{ code: string }>(
      '/api/finance/dimension',
      { code: dimCode.trim(), name: dimName.trim() },
      { idempotencyKey: dimIdem },
    );
    setDimBusy(false);
    if (res.ok) {
      setDimMsg({ tone: 'success', text: `Dimension "${dimName.trim()}" created.` });
      setDimCode(''); setDimName(''); setDimIdem(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setDimMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setDimMsg({ tone: 'danger', text: `Could not create the dimension (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const addValue = async () => {
    if (valDim.trim() === '' || valCode.trim() === '' || valLabel.trim() === '') return;
    setValBusy(true); setValMsg(null);
    const res = await mutate<{ dimensionCode: string; valueCode: string }>(
      '/api/finance/dimension/value',
      { dimensionCode: valDim.trim(), valueCode: valCode.trim(), label: valLabel.trim() },
      { idempotencyKey: valIdem },
    );
    setValBusy(false);
    if (res.ok) {
      setValMsg({ tone: 'success', text: `Value "${valLabel.trim()}" added.` });
      setValCode(''); setValLabel(''); setValIdem(newIdempotencyKey());
      try { await load(); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setValMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setValMsg({ tone: 'danger', text: `Could not add the value (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Reporting dimensions">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Dimension registry (FIN-001)</h3>
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="dim-refresh" disabled={state === 'loading'} onClick={() => void load()}>Refresh</Button>
          </div>
          <StatusTag tone={dimensions.length > 0 ? 'success' : 'neutral'} icon={dimensions.length > 0 ? 'check' : 'info'}>
            {`${dimensions.length} dimensions`}
          </StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading dimensions" />}
        {state === 'error' && <StateBlock state="stale" title="Dimensions unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          dimensions.length === 0
            ? <StateBlock state="empty" title="No dimensions yet">Create one below, then add its values.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="dim-list">
                  <caption className="sancta-visually-hidden">Reporting dimensions and their enumerated values</caption>
                  <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Values</th></tr></thead>
                  <tbody>
                    {dimensions.map((d) => (
                      <tr key={d.code} data-selected={valDim === d.code || undefined}>
                        <td data-numeric>{d.code}</td>
                        <td>{d.name}</td>
                        <td>
                          {d.values.length === 0
                            ? <span className="scr__kpi-meta">no values yet</span>
                            : <div className="scr__row" style={{ flexWrap: 'wrap', gap: 'var(--sancta-space-1)' }}>
                                {d.values.map((v) => <StatusTag key={v.valueCode} tone={v.active ? 'info' : 'neutral'} icon={null}>{`${v.valueCode} · ${v.label}`}</StatusTag>)}
                              </div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="dim-add-value-form">
        <h3 className="scr__section-title">Add a value</h3>
        <p className="scr__kpi-meta">Pick a dimension from the list above, or type its code, then add an enumerated value.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <label className="sancta-field">
            <span className="sancta-field__label">Dimension</span>
            <select className="sancta-field-input" data-testid="dim-value-dim" value={valDim} onChange={(e) => setValDim(e.currentTarget.value)}>
              <option value="">Select dimension…</option>
              {dimensions.map((d) => <option key={d.code} value={d.code}>{d.code} · {d.name}</option>)}
            </select>
          </label>
          <Field label="Value code" hint="Short code within the dimension" data-testid="dim-value-code" value={valCode} onChange={(e) => setValCode(e.currentTarget.value)} />
          <Field label="Label" hint="Human-readable name" data-testid="dim-value-label" value={valLabel} onChange={(e) => setValLabel(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="dim-value-submit" disabled={valBusy}
            {...(valDim.trim() === '' ? { disabledReason: 'Choose a dimension' } : valCode.trim() === '' ? { disabledReason: 'Enter the value code' } : valLabel.trim() === '' ? { disabledReason: 'Enter the label' } : {})}
            onClick={addValue}>Add value</Button>
        </div>
        {valMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={valMsg.tone} assertive={valMsg.tone === 'danger'}>{valMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="dim-form">
        <h3 className="scr__section-title">Create a dimension</h3>
        <p className="scr__kpi-meta">A dimension is an analysis axis with an enumerated value set. The clinic hub rejects a duplicate code.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Code" hint="Short unique identifier" data-testid="dim-code" value={dimCode} onChange={(e) => setDimCode(e.currentTarget.value)} />
          <Field label="Name" hint="What this dimension is" data-testid="dim-name" value={dimName} onChange={(e) => setDimName(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="dim-submit" disabled={dimBusy}
            {...(dimCode.trim() === '' ? { disabledReason: 'Enter the dimension code' } : dimName.trim() === '' ? { disabledReason: 'Enter the dimension name' } : {})}
            onClick={createDimension}>Create dimension</Button>
        </div>
        {dimMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={dimMsg.tone} assertive={dimMsg.tone === 'danger'}>{dimMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
