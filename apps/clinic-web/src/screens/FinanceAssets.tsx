import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Asset = {
  id: string; reference: string; name: string; costMinor: number; asOf: string; status: string;
  monthlyMinor: number; accumulatedMinor: number; netBookValueMinor: number;
};

function isoToday(): string { return new Date().toISOString().slice(0, 10); }
/** Parse a dollar amount into integer minor units (cents); NaN when not a number. */
function toMinor(s: string): number { const n = Number(s.trim()); return Number.isFinite(n) ? Math.round(n * 100) : NaN; }

/**
 * Fixed-asset register (FIN-008). The register values every asset as-of a date —
 * straight-line depreciation, accumulated depreciation and net book value computed
 * from the immutable cost/life, never an editable total — so it is safe to read on
 * mount and re-query by date. Two writes capitalise a new asset and dispose of an
 * existing one; disposal records proceeds and the gain/loss against net book value.
 * Both are §9.2 confirmed-commit writes (idempotency key per intent, draft kept on
 * failure) and the register reloads only after the hub durably accepts them.
 */
export function FinanceAssets() {
  const [asOf, setAsOf] = useState(isoToday());
  const [assets, setAssets] = useState<Asset[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Capitalise draft (dollar strings for money; months as a plain count).
  const [reference, setReference] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [cost, setCost] = useState('');
  const [salvage, setSalvage] = useState('');
  const [life, setLife] = useState('');
  const [acquiredOn, setAcquiredOn] = useState(isoToday());
  const [capIdem, setCapIdem] = useState(newIdempotencyKey());
  const [capBusy, setCapBusy] = useState(false);
  const [capMsg, setCapMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Dispose draft.
  const [disposeId, setDisposeId] = useState('');
  const [disposeRef, setDisposeRef] = useState('');
  const [disposedOn, setDisposedOn] = useState(isoToday());
  const [proceeds, setProceeds] = useState('');
  const [dispIdem, setDispIdem] = useState(newIdempotencyKey());
  const [dispBusy, setDispBusy] = useState(false);
  const [dispMsg, setDispMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (d: string) => {
    setState('loading');
    try {
      const r = await jsonFetch<{ assets: Asset[] }>(`/api/finance/asset/register?asOf=${encodeURIComponent(d)}`);
      setAssets(r.assets); setState('ready');
    } catch { setState('error'); }
  }, []);

  useEffect(() => { void load(asOf); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const costMinor = toMinor(cost);
  const lifeMonths = Math.floor(Number(life.trim()));
  const capReady = reference.trim() !== '' && name.trim() !== '' && cost.trim() !== '' && Number.isFinite(costMinor) && life.trim() !== '' && Number.isFinite(lifeMonths) && lifeMonths > 0 && acquiredOn.trim() !== '';
  const capBlock = reference.trim() === '' ? 'Enter the asset reference'
    : name.trim() === '' ? 'Enter the asset name'
    : cost.trim() === '' || !Number.isFinite(costMinor) ? 'Enter the acquisition cost'
    : life.trim() === '' || !Number.isFinite(lifeMonths) || lifeMonths <= 0 ? 'Enter the useful life in whole months'
    : acquiredOn.trim() === '' ? 'Enter the acquisition date'
    : '';

  const capitalise = async () => {
    if (!capReady) return;
    setCapBusy(true); setCapMsg(null);
    const body = {
      reference: reference.trim(),
      name: name.trim(),
      costMinor,
      usefulLifeMonths: lifeMonths,
      acquiredOn,
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(salvage.trim() && Number.isFinite(toMinor(salvage)) ? { salvageMinor: toMinor(salvage) } : {}),
    };
    const res = await mutate<{ id: string }>('/api/finance/asset', body, { idempotencyKey: capIdem });
    setCapBusy(false);
    if (res.ok) {
      setCapMsg({ tone: 'success', text: `Capitalised "${name.trim()}" (${reference.trim()}) at $${money(costMinor)}.` });
      setReference(''); setName(''); setCategory(''); setCost(''); setSalvage(''); setLife(''); setCapIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setCapMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else if (res.errorCode === 'asset_rejected') {
      setCapMsg({ tone: 'danger', text: `Rejected (${res.errorMessage ?? 'check the reference, cost and salvage'}). Your entry is kept.` });
    } else {
      setCapMsg({ tone: 'danger', text: `Could not capitalise the asset (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const beginDispose = (a: Asset) => { setDisposeId(a.id); setDisposeRef(a.reference); setProceeds(''); setDispIdem(newIdempotencyKey()); setDispMsg(null); };

  const proceedsMinor = toMinor(proceeds);
  const dispReady = disposeId.trim() !== '' && disposedOn.trim() !== '' && proceeds.trim() !== '' && Number.isFinite(proceedsMinor);

  const dispose = async () => {
    if (!dispReady) return;
    setDispBusy(true); setDispMsg(null);
    const res = await mutate<{ id: string; netBookValueMinor: number; gainLossMinor: number }>(
      '/api/finance/asset/dispose',
      { assetId: disposeId.trim(), disposedOn, proceedsMinor },
      { idempotencyKey: dispIdem },
    );
    setDispBusy(false);
    if (res.ok && res.data) {
      const gl = res.data.gainLossMinor;
      setDispMsg({ tone: 'success', text: `Disposed for $${money(proceedsMinor)} against net book value $${money(res.data.netBookValueMinor)} — ${gl >= 0 ? 'gain' : 'loss'} $${money(Math.abs(gl))}.` });
      setDisposeId(''); setDisposeRef(''); setProceeds(''); setDispIdem(newIdempotencyKey());
      try { await load(asOf); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setDispMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else if (res.errorCode === 'asset_rejected') {
      setDispMsg({ tone: 'danger', text: `Rejected (${res.errorMessage ?? 'the asset is unknown or already disposed'}). Your entry is kept.` });
    } else {
      setDispMsg({ tone: 'danger', text: `Could not dispose the asset (${res.errorMessage ?? res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  const liveCount = assets.filter((a) => a.status !== 'disposed').length;

  return (
    <section className="scr" aria-label="Asset register">
      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="scr__toolbar">
            <h3 className="scr__section-title">Fixed-asset register (FIN-008)</h3>
            <Field label="As of" type="date" hint="Valuation date" data-testid="asset-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
            <Button variant="secondary" icon={<Icon name="sync" />} data-testid="asset-refresh" disabled={state === 'loading'} onClick={() => void load(asOf)}>Refresh</Button>
          </div>
          <StatusTag tone={liveCount > 0 ? 'success' : 'neutral'} icon={liveCount > 0 ? 'check' : 'info'}>{`${liveCount} in service`}</StatusTag>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Loading asset register" />}
        {state === 'error' && <StateBlock state="stale" title="Asset register unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && (
          assets.length === 0
            ? <StateBlock state="empty" title="No assets yet">Capitalise one below; it will appear here with its depreciation and net book value.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="asset-list">
                  <caption className="sancta-visually-hidden">Fixed assets valued at the selected date with depreciation and net book value</caption>
                  <thead><tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Name</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Cost</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Accum. dep.</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Net book value</th>
                    <th scope="col">Status</th>
                    <th scope="col"></th>
                  </tr></thead>
                  <tbody>
                    {assets.map((a, i) => (
                      <tr key={a.id} data-selected={disposeId === a.id || undefined}>
                        <td data-numeric>{a.reference}</td>
                        <td>{a.name}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{`$${money(a.costMinor)}`}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{`$${money(a.accumulatedMinor)}`}</td>
                        <td data-numeric style={{ textAlign: 'right' }}>{`$${money(a.netBookValueMinor)}`}</td>
                        <td><StatusTag tone={a.status === 'disposed' ? 'neutral' : 'success'} icon={a.status === 'disposed' ? null : 'check'}>{a.status}</StatusTag></td>
                        <td style={{ textAlign: 'right' }}>
                          {a.status === 'disposed'
                            ? <span className="scr__kpi-meta">—</span>
                            : <Button variant="subtle" density="compact" data-testid={`asset-dispose-${i}`} onClick={() => beginDispose(a)}>Dispose</Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      {disposeId && (
        <div className="scr__card" data-testid="asset-dispose-form">
          <h3 className="scr__section-title">Dispose of an asset</h3>
          <p className="scr__kpi-meta">Recording a disposal settles the asset at its net book value and books the gain or loss against the proceeds. Asset reference: {disposeRef}.</p>
          <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
            <Field label="Disposed on" type="date" hint="Date of disposal" data-testid="asset-disposed-on" value={disposedOn} onChange={(e) => setDisposedOn(e.currentTarget.value)} />
            <Field label="Proceeds" numeric prefix="$" hint="Amount received on disposal" data-testid="asset-proceeds" value={proceeds} onChange={(e) => setProceeds(e.currentTarget.value)} />
          </div>
          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" tone="danger" icon={<Icon name="check" />} data-testid="asset-dispose-submit" disabled={dispBusy}
              {...(proceeds.trim() === '' || !Number.isFinite(proceedsMinor) ? { disabledReason: 'Enter the disposal proceeds' } : disposedOn.trim() === '' ? { disabledReason: 'Enter the disposal date' } : {})}
              onClick={dispose}>Record disposal</Button>
            <Button variant="subtle" data-testid="asset-dispose-cancel" disabled={dispBusy} onClick={() => { setDisposeId(''); setDisposeRef(''); setDispMsg(null); }}>Cancel</Button>
          </div>
          {dispMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={dispMsg.tone} assertive={dispMsg.tone === 'danger'}>{dispMsg.text}</Banner></div>}
        </div>
      )}
      {!disposeId && dispMsg && <div data-testid="asset-dispose-result"><Banner tone={dispMsg.tone}>{dispMsg.text}</Banner></div>}

      <div className="scr__card" data-testid="asset-cap-form">
        <h3 className="scr__section-title">Capitalise an asset</h3>
        <p className="scr__kpi-meta">Add an asset to the register. Cost and salvage are in dollars; useful life is in whole months. Depreciation is spread straight-line and net book value never falls below salvage.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Reference" hint="Unique asset reference" data-testid="asset-reference" value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
          <Field label="Name" hint="What the asset is" data-testid="asset-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Field label="Category" optional hint="Grouping for reporting" data-testid="asset-category" value={category} onChange={(e) => setCategory(e.currentTarget.value)} />
          <Field label="Cost" numeric prefix="$" hint="Acquisition cost" data-testid="asset-cost" value={cost} onChange={(e) => setCost(e.currentTarget.value)} />
          <Field label="Salvage" optional numeric prefix="$" hint="Residual value at end of life" data-testid="asset-salvage" value={salvage} onChange={(e) => setSalvage(e.currentTarget.value)} />
          <Field label="Useful life (months)" numeric hint="Whole months over which to depreciate" data-testid="asset-life" value={life} onChange={(e) => setLife(e.currentTarget.value)} />
          <Field label="Acquired on" type="date" hint="Date the asset was acquired" data-testid="asset-acquired" value={acquiredOn} onChange={(e) => setAcquiredOn(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="asset-cap-submit" disabled={capBusy}
            {...(capReady ? {} : { disabledReason: capBlock })}
            onClick={capitalise}>Capitalise asset</Button>
        </div>
        {capMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={capMsg.tone} assertive={capMsg.tone === 'danger'}>{capMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
