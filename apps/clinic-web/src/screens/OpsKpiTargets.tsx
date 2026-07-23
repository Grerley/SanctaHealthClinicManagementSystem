import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import type { IconName } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type KpiBand = { status: 'on_target' | 'warning' | 'critical' | 'no_target'; colour: 'green' | 'amber' | 'red' | 'grey' };
type KpiComparison = {
  kpiId: string;
  current: number;
  prior: number | null;
  delta: number | null;
  trend: 'up' | 'down' | 'flat';
  band: KpiBand;
  refreshedAt: string;
};
type ComparisonResponse = KpiComparison | { error: { code?: string; message?: string } };

function isComparison(r: ComparisonResponse): r is KpiComparison {
  return 'band' in r;
}

const BAND_TONE: Record<KpiBand['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  on_target: 'success', warning: 'warning', critical: 'danger', no_target: 'neutral',
};
const BAND_ICON: Record<KpiBand['status'], IconName | null> = {
  on_target: 'check', warning: 'alert', critical: 'alert', no_target: null,
};
const BAND_LABEL: Record<KpiBand['status'], string> = {
  on_target: 'On target', warning: 'Warning', critical: 'Critical', no_target: 'No target set',
};
const TREND_LABEL: Record<KpiComparison['trend'], string> = { up: '▲ up', down: '▼ down', flat: '— flat' };

/**
 * KPI targets + period comparison (MGT-004, MGT-005). The comparison is a read
 * scoped by kpiId + two period strings — it bands the current value against the
 * effective target and shows the period-over-period delta. Setting a target is a
 * confirmed-commit write (§9.2): success only on res.ok, the draft is preserved on
 * failure. Targets are effective-dated; a new version must post-date the current one.
 */
export function OpsKpiTargets() {
  // Comparison read.
  const [cmpKpiId, setCmpKpiId] = useState('');
  const [period, setPeriod] = useState('');
  const [priorPeriod, setPriorPeriod] = useState('');
  const [cmp, setCmp] = useState<KpiComparison | null>(null);
  const [cmpState, setCmpState] = useState<'idle' | 'loading' | 'ready' | 'blocked' | 'error'>('idle');
  const [cmpMsg, setCmpMsg] = useState<string | null>(null);

  // Set-target draft.
  const [kpiId, setKpiId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [target, setTarget] = useState('');
  const [warnAt, setWarnAt] = useState('');
  const [critAt, setCritAt] = useState('');
  const [direction, setDirection] = useState<'higher_better' | 'lower_better'>('higher_better');
  const [commentary, setCommentary] = useState('');
  const [targetIdem, setTargetIdem] = useState(newIdempotencyKey());
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const runComparison = async () => {
    if (cmpKpiId.trim() === '' || period.trim() === '') return;
    setCmpState('loading'); setCmp(null); setCmpMsg(null);
    try {
      const r = await jsonFetch<ComparisonResponse>(
        `/api/kpi/comparison?kpiId=${encodeURIComponent(cmpKpiId.trim())}&period=${encodeURIComponent(period.trim())}&priorPeriod=${encodeURIComponent(priorPeriod.trim())}`,
      );
      if (isComparison(r)) { setCmp(r); setCmpState('ready'); }
      else { setCmpMsg(r.error?.message ?? 'No snapshot for this KPI and period.'); setCmpState('blocked'); }
    } catch { setCmpState('error'); }
  };

  const numOrUndef = (s: string): number | undefined => {
    const v = Number(s);
    return s.trim() === '' || !Number.isFinite(v) ? undefined : v;
  };

  const saveTarget = async () => {
    if (kpiId.trim() === '' || effectiveFrom.trim() === '') return;
    const t = numOrUndef(target); const w = numOrUndef(warnAt); const c = numOrUndef(critAt);
    setSaving(true); setSaveMsg(null);
    const res = await mutate<{ kpiId: string; version: number }>(
      '/api/kpi/target',
      {
        kpiId: kpiId.trim(),
        effectiveFrom,
        direction,
        ...(t !== undefined ? { target: t } : {}),
        ...(w !== undefined ? { warnAt: w } : {}),
        ...(c !== undefined ? { critAt: c } : {}),
        ...(commentary.trim() ? { commentary: commentary.trim() } : {}),
      },
      { idempotencyKey: targetIdem },
    );
    setSaving(false);
    if (res.ok && res.data?.version !== undefined) {
      setSaveMsg({ tone: 'success', text: `Target set for ${kpiId.trim()} — version ${res.data.version} effective ${effectiveFrom}.` });
      setTarget(''); setWarnAt(''); setCritAt(''); setCommentary(''); setTargetIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setSaveMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setSaveMsg({ tone: 'danger', text: `Could not set the target (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="KPI targets and comparison">
      <div className="scr__card" data-testid="kpi-comparison-form">
        <h3 className="scr__section-title">Compare a KPI (MGT-005)</h3>
        <p className="scr__kpi-meta">Bands the current period's snapshot against its effective target and shows the change from the prior period.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="KPI id" hint="The KPI to compare" data-testid="kpi-cmp-id" value={cmpKpiId} onChange={(e) => setCmpKpiId(e.currentTarget.value)} />
          <Field label="Period" hint="e.g. 2026-06" data-testid="kpi-cmp-period" value={period} onChange={(e) => setPeriod(e.currentTarget.value)} />
          <Field label="Prior period" hint="e.g. 2026-05" data-testid="kpi-cmp-prior" value={priorPeriod} onChange={(e) => setPriorPeriod(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="sync" />} data-testid="kpi-cmp-submit" disabled={cmpState === 'loading'}
            {...(cmpKpiId.trim() === '' ? { disabledReason: 'Enter the KPI id' } : period.trim() === '' ? { disabledReason: 'Enter the period' } : {})}
            onClick={runComparison}>Compare</Button>
        </div>
        {cmpState === 'loading' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="initial-loading" title="Comparing" /></div>}
        {cmpState === 'error' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="stale" title="Comparison unavailable">The clinic hub may be unreachable.</StateBlock></div>}
        {cmpState === 'blocked' && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone="warning">{cmpMsg ?? 'No snapshot for this KPI and period.'}</Banner></div>}
        {cmpState === 'ready' && cmp && (
          <div className="scr__kpi-grid" style={{ marginTop: 'var(--sancta-space-3)' }} data-testid="kpi-cmp-result">
            <div className="scr__kpi">
              <span className="scr__kpi-label">Current</span>
              <span className="scr__kpi-value">{cmp.current}</span>
              <StatusTag tone={BAND_TONE[cmp.band.status]} icon={BAND_ICON[cmp.band.status]}>{BAND_LABEL[cmp.band.status]}</StatusTag>
            </div>
            <div className="scr__kpi">
              <span className="scr__kpi-label">Prior</span>
              <span className="scr__kpi-value">{cmp.prior ?? '—'}</span>
            </div>
            <div className="scr__kpi">
              <span className="scr__kpi-label">Change</span>
              <span className="scr__kpi-value">{cmp.delta === null ? '—' : cmp.delta}</span>
              <span className="scr__kpi-meta">{TREND_LABEL[cmp.trend]}</span>
            </div>
          </div>
        )}
      </div>

      <div className="scr__card" data-testid="kpi-target-form">
        <h3 className="scr__section-title">Set a target (MGT-004)</h3>
        <p className="scr__kpi-meta">Define the next effective-dated target version. The effective date must be after the current version's. Warn/critical thresholds band the value in the comparison above.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="KPI id" hint="The KPI to target" data-testid="kpi-target-id" value={kpiId} onChange={(e) => setKpiId(e.currentTarget.value)} />
          <Field label="Effective from" type="date" hint="When this version takes effect" data-testid="kpi-target-from" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.currentTarget.value)} />
          <Field label="Target" optional numeric type="number" hint="Goal value" data-testid="kpi-target-value" value={target} onChange={(e) => setTarget(e.currentTarget.value)} />
          <Field label="Warn at" optional numeric type="number" hint="Warning threshold" data-testid="kpi-target-warn" value={warnAt} onChange={(e) => setWarnAt(e.currentTarget.value)} />
          <Field label="Critical at" optional numeric type="number" hint="Critical threshold" data-testid="kpi-target-crit" value={critAt} onChange={(e) => setCritAt(e.currentTarget.value)} />
          <Field label="Commentary" optional hint="Why this target" data-testid="kpi-target-commentary" value={commentary} onChange={(e) => setCommentary(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', gap: 'var(--sancta-space-3)', marginTop: 'var(--sancta-space-3)' }}>
          <div className="scr__seg" role="group" aria-label="Direction" data-testid="kpi-target-direction">
            <button type="button" className="scr__seg-btn" data-active={direction === 'higher_better'} aria-pressed={direction === 'higher_better'} onClick={() => setDirection('higher_better')}>Higher is better</button>
            <button type="button" className="scr__seg-btn" data-active={direction === 'lower_better'} aria-pressed={direction === 'lower_better'} onClick={() => setDirection('lower_better')}>Lower is better</button>
          </div>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="kpi-target-submit" disabled={saving}
            {...(kpiId.trim() === '' ? { disabledReason: 'Enter the KPI id' } : effectiveFrom.trim() === '' ? { disabledReason: 'Enter the effective date' } : {})}
            onClick={saveTarget}>Set target</Button>
        </div>
        {saveMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={saveMsg.tone} assertive={saveMsg.tone === 'danger'}>{saveMsg.text}</Banner></div>}
      </div>
    </section>
  );
}
