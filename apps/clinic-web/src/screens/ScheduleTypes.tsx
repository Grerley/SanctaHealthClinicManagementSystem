import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type AppointmentType = { code: string; version: number; name: string; durationMin: number; prep: string | null; depositMinor: number };
const isoToday = (): string => new Date().toISOString().slice(0, 10);

/**
 * Appointment types (APT-007). Effective-dated, versioned service definitions: look up
 * the version in force on a date, and publish a new version effective from a future
 * date (superseding, never overwriting). Publishing is a confirmed-commit write (§9.2).
 */
export function ScheduleTypes() {
  const [lookupCode, setLookupCode] = useState('');
  const [asOf, setAsOf] = useState(isoToday());
  const [found, setFound] = useState<AppointmentType | 'none' | null>(null);
  const [looking, setLooking] = useState(false);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [prep, setPrep] = useState('');
  const [deposit, setDeposit] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const lookup = async () => {
    if (lookupCode.trim() === '') return;
    setLooking(true); setFound(null);
    try {
      const t = await jsonFetch<AppointmentType>(`/api/schedule/type?code=${encodeURIComponent(lookupCode.trim())}&asOf=${encodeURIComponent(asOf)}`);
      setFound(t);
    } catch { setFound('none'); }
    setLooking(false);
  };

  const durOk = /^\d+$/.test(durationMin.trim()) && Number(durationMin) > 0;
  const ready = code.trim() !== '' && name.trim() !== '' && effectiveFrom.trim() !== '' && durOk;

  const publish = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ code: string; version: number }>(
      '/api/schedule/type',
      {
        code: code.trim(), name: name.trim(), effectiveFrom, durationMin: Number(durationMin),
        ...(prep.trim() ? { prep: prep.trim() } : {}),
        ...(deposit.trim() && /^\d+(\.\d{1,2})?$/.test(deposit.trim()) ? { depositMinor: Math.round(Number(deposit) * 100) } : {}),
      },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok && res.data) {
      setMsg({ tone: 'success', text: `Published ${res.data.code} v${res.data.version}, effective ${effectiveFrom}.` });
      setName(''); setEffectiveFrom(''); setDurationMin(''); setPrep(''); setDeposit(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not publish the type (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Appointment types">
      <div className="scr__card" data-testid="appt-type-lookup">
        <h3 className="scr__section-title">Version in force</h3>
        <div className="scr__toolbar" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Code" hint="Appointment-type code" data-testid="appt-type-lookup-code" value={lookupCode} onChange={(e) => setLookupCode(e.currentTarget.value)} />
          <Field label="As of" type="date" hint="Date to resolve on" data-testid="appt-type-lookup-asof" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} />
          <Button variant="secondary" icon={<Icon name="sync" />} data-testid="appt-type-lookup-go" disabled={looking}
            {...(lookupCode.trim() === '' ? { disabledReason: 'Enter a code' } : {})} onClick={lookup}>Look up</Button>
        </div>
        {found === 'none' && <StateBlock state="empty" title="No version in force">No appointment type with that code is effective on this date.</StateBlock>}
        {found && found !== 'none' && (
          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-2)' }}>
            <table className="scr__table" data-testid="appt-type-found">
              <caption className="sancta-visually-hidden">The appointment-type version in force on the selected date</caption>
              <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Version</th><th scope="col">Duration</th><th scope="col">Deposit</th></tr></thead>
              <tbody><tr>
                <td data-numeric>{found.code}</td><td>{found.name}</td>
                <td data-numeric><StatusTag tone="info">{`v${found.version}`}</StatusTag></td>
                <td data-numeric>{`${found.durationMin} min`}</td>
                <td data-numeric>{`$${(found.depositMinor / 100).toFixed(2)}`}</td>
              </tr></tbody>
            </table>
          </div>
        )}
      </div>

      <div className="scr__card" data-testid="appt-type-form">
        <h3 className="scr__section-title">Publish a version</h3>
        <p className="scr__kpi-meta">A new version must be effective after the current one; it supersedes rather than overwriting, keeping the history intact.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Code" hint="Appointment-type code" data-testid="appt-type-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Name" hint="Display name" data-testid="appt-type-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Field label="Effective from" type="date" hint="After the current version" data-testid="appt-type-effective" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.currentTarget.value)} />
          <Field label="Duration (min)" numeric hint="Whole minutes" data-testid="appt-type-duration" value={durationMin} onChange={(e) => setDurationMin(e.currentTarget.value)} />
          <Field label="Prep" optional hint="Preparation notes" data-testid="appt-type-prep" value={prep} onChange={(e) => setPrep(e.currentTarget.value)} />
          <Field label="Deposit" optional numeric prefix="$" hint="Booking deposit" data-testid="appt-type-deposit" value={deposit} onChange={(e) => setDeposit(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="appt-type-submit" disabled={busy}
            {...(code.trim() === '' ? { disabledReason: 'Enter the code' } : name.trim() === '' ? { disabledReason: 'Enter the name' } : effectiveFrom.trim() === '' ? { disabledReason: 'Enter the effective date' } : !durOk ? { disabledReason: 'Enter a positive duration in minutes' } : {})}
            onClick={publish}>Publish version</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
