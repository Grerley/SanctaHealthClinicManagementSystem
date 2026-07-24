import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { jsonFetch } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const BY = 'demo-operator';
type CodeHit = { code: string; display: string };

/**
 * Record a diagnosis (CLR-005). Search the coded terminology, then record a diagnosis
 * against an encounter — a code or free text is required, with an optional certainty.
 * Confirmed-commit write (§9.2); the draft is preserved on failure.
 */
export function RecordDiagnosis({ patient }: { patient: Patient | null }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CodeHit[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const [encounterId, setEncounterId] = useState('');
  const [code, setCode] = useState('');
  const [freeText, setFreeText] = useState('');
  const [certainty, setCertainty] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const search = async () => {
    setSearchState('loading');
    try { const r = await jsonFetch<{ codes: CodeHit[] }>(`/api/ehr/diagnosis-codes?q=${encodeURIComponent(q.trim())}`); setHits(r.codes); setSearchState('ready'); }
    catch { setSearchState('error'); }
  };

  const ready = encounterId.trim() !== '' && (code.trim() !== '' || freeText.trim() !== '');

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string; display: string | null }>(
      '/api/ehr/diagnosis',
      {
        encounterId: encounterId.trim(), user: BY,
        ...(code.trim() ? { code: code.trim() } : {}),
        ...(freeText.trim() ? { freeText: freeText.trim() } : {}),
        ...(certainty.trim() ? { certainty: certainty.trim() } : {}),
      },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok) {
      setMsg({ tone: 'success', text: `Recorded diagnosis${res.data?.display ? ` — ${res.data.display}` : ''}.` });
      setCode(''); setFreeText(''); setCertainty(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not record the diagnosis (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Record diagnosis">
      <div className="scr__card" data-testid="diagnosis-search">
        <div className="scr__toolbar">
          <h3 className="scr__section-title">Find a code</h3>
          <Field label="Search terminology" hideLabel hint="Term or code" data-testid="diagnosis-q" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
          <Button variant="secondary" icon={<Icon name="sync" />} data-testid="diagnosis-search-go" disabled={searchState === 'loading'} onClick={search}>Search</Button>
        </div>
        {searchState === 'loading' && <StateBlock state="initial-loading" title="Searching codes" />}
        {searchState === 'error' && <StateBlock state="stale" title="Terminology unavailable">The clinic hub may be unreachable.</StateBlock>}
        {searchState === 'ready' && (
          hits.length === 0
            ? <StateBlock state="empty" title="No codes">No terminology matches that search.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="diagnosis-codes">
                  <caption className="sancta-visually-hidden">Diagnosis codes matching the search</caption>
                  <thead><tr><th scope="col">Code</th><th scope="col">Display</th><th scope="col"></th></tr></thead>
                  <tbody>{hits.map((h) => (<tr key={h.code} data-selected={code === h.code || undefined}><td data-numeric>{h.code}</td><td>{h.display}</td><td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`diagnosis-pick-${h.code}`} onClick={() => setCode(h.code)}>Use</Button></td></tr>))}</tbody>
                </table>
              </div>
            )
        )}
      </div>

      <div className="scr__card" data-testid="diagnosis-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Record against an encounter</h3>
          {patient && <StatusTag tone="info" icon="info">{`${patient.given_name} ${patient.family_name}`}</StatusTag>}
        </div>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Encounter id" hint="The encounter to code" data-testid="diagnosis-encounter" value={encounterId} onChange={(e) => setEncounterId(e.currentTarget.value)} />
          <Field label="Code" optional hint="From the search, or paste" data-testid="diagnosis-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Free text" optional hint="If no code applies" data-testid="diagnosis-freetext" value={freeText} onChange={(e) => setFreeText(e.currentTarget.value)} />
          <Field label="Certainty" optional hint="e.g. confirmed, provisional" data-testid="diagnosis-certainty" value={certainty} onChange={(e) => setCertainty(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="diagnosis-submit" disabled={busy}
            {...(encounterId.trim() === '' ? { disabledReason: 'Enter the encounter id' } : (code.trim() === '' && freeText.trim() === '') ? { disabledReason: 'Enter a code or free text' } : {})}
            onClick={submit}>Record diagnosis</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
