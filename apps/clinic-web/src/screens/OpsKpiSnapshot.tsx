import { useState } from 'react';
import { Banner, Button, Field, Icon } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * KPI period snapshot (MGT-005). Records a KPI's value for a period; a repeated
 * period overwrites its snapshot. This is a confirmed-commit write (§9.2): success
 * is shown only on res.ok, and the draft is preserved on failure so nothing entered
 * is lost. Snapshots are what the period comparison reads.
 */
export function OpsKpiSnapshot() {
  const [kpiId, setKpiId] = useState('');
  const [period, setPeriod] = useState('');
  const [value, setValue] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const valueNum = Number(value);
  const valueValid = value.trim() !== '' && Number.isFinite(valueNum);

  const capture = async () => {
    if (kpiId.trim() === '' || period.trim() === '' || !valueValid) return;
    setSaving(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/kpi/snapshot',
      { kpiId: kpiId.trim(), period: period.trim(), value: valueNum },
      { idempotencyKey: idem },
    );
    setSaving(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `Snapshot recorded for ${kpiId.trim()} ${period.trim()} = ${valueNum}. Snapshot id ···${res.data.id.slice(-8)}.` });
      setValue(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not record the snapshot (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="KPI snapshot">
      <div className="scr__card" data-testid="kpi-snapshot-form">
        <h3 className="scr__section-title">Capture a KPI snapshot (MGT-005)</h3>
        <p className="scr__kpi-meta">Record a KPI's value for one period. Recording the same period again overwrites its snapshot. Snapshots feed the period-over-period comparison.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="KPI id" hint="The KPI being measured" data-testid="kpi-snapshot-id" value={kpiId} onChange={(e) => setKpiId(e.currentTarget.value)} />
          <Field label="Period" hint="e.g. 2026-06" data-testid="kpi-snapshot-period" value={period} onChange={(e) => setPeriod(e.currentTarget.value)} />
          <Field label="Value" numeric type="number" hint="The measured value" data-testid="kpi-snapshot-value" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="kpi-snapshot-submit" disabled={saving}
            {...(kpiId.trim() === '' ? { disabledReason: 'Enter the KPI id' } : period.trim() === '' ? { disabledReason: 'Enter the period' } : !valueValid ? { disabledReason: 'Enter a numeric value' } : {})}
            onClick={capture}>Capture snapshot</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
