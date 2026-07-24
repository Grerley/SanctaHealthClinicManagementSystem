import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch } from '../api.ts';
import './screens.css';

type NextSlot = { slotId: string; startsAt: string } | null;

/**
 * Next available slot (APT-002). A read-only finder: given a provider and an earliest
 * time, return the first free slot on or after it, so front desk can offer the soonest
 * appointment without scanning the calendar.
 */
export function ScheduleNext() {
  const [provider, setProvider] = useState('');
  const [after, setAfter] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [slot, setSlot] = useState<NextSlot>(null);

  const find = async () => {
    if (provider.trim() === '') return;
    setState('loading'); setSlot(null);
    try {
      const afterIso = after.trim() ? new Date(after.trim()).toISOString() : new Date().toISOString();
      const r = await jsonFetch<{ slot: NextSlot }>(`/api/schedule/next?provider=${encodeURIComponent(provider.trim())}&after=${encodeURIComponent(afterIso)}`);
      setSlot(r.slot); setState('ready');
    } catch { setState('error'); }
  };

  return (
    <section className="scr" aria-label="Next available slot">
      <div className="scr__card" data-testid="next-slot-form">
        <h3 className="scr__section-title">Find the next opening</h3>
        <div className="scr__toolbar" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Provider" hint="Clinician to book with" data-testid="next-slot-provider" value={provider} onChange={(e) => setProvider(e.currentTarget.value)} />
          <Field label="Not before" optional type="datetime-local" hint="Earliest acceptable time" data-testid="next-slot-after" value={after} onChange={(e) => setAfter(e.currentTarget.value)} />
          <Button variant="primary" icon={<Icon name="sync" />} data-testid="next-slot-go" disabled={state === 'loading'}
            {...(provider.trim() === '' ? { disabledReason: 'Enter a provider' } : {})} onClick={find}>Find slot</Button>
        </div>
        {state === 'loading' && <StateBlock state="initial-loading" title="Searching" />}
        {state === 'error' && <StateBlock state="stale" title="Search unavailable">The clinic hub may be unreachable.</StateBlock>}
        {state === 'ready' && slot === null && <StateBlock state="empty" title="No opening found">No free slot for this provider on or after that time.</StateBlock>}
        {state === 'ready' && slot !== null && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Banner tone="success">{`Next opening: ${new Date(slot.startsAt).toLocaleString()} — slot ···${slot.slotId.slice(-8)}.`}</Banner>
            <div style={{ marginTop: 'var(--sancta-space-2)' }}><StatusTag tone="success" icon="check">{`Slot ···${slot.slotId.slice(-8)}`}</StatusTag></div>
          </div>
        )}
      </div>
    </section>
  );
}
