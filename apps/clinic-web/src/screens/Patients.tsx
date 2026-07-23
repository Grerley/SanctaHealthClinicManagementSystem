import { useEffect, useState } from 'react';
import { Button, Field, Banner } from '@sancta/ui';
import { api, type Patient } from '../api.ts';
import './screens.css';

/**
 * Patient search + registration (PAT-01/02/03/05). Search states its local scope;
 * results show why each matched; registration surfaces probable duplicates for a
 * reasoned override before creating a second record (PAT-003, BR-002). DOM contract
 * preserved for the e2e suite.
 */
export function Patients({ onSelect }: { onSelect?: (p: Patient) => void } = {}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Patient[]>([]);
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState('');
  const [dob, setDob] = useState('');
  const [message, setMessage] = useState('');
  const [duplicates, setDuplicates] = useState<Array<{ candidate: Patient; reasons: string[] }>>([]);

  const search = async (term: string) => {
    setQ(term);
    if (term.trim().length < 2) { setResults([]); return; }
    try { setResults((await api.searchPatients(term)).patients); } catch { /* offline */ }
  };

  useEffect(() => { void search(''); }, []);

  const register = async (force = false) => {
    setMessage(''); setDuplicates([]);
    try {
      const res = await api.registerPatient({ givenName: given, familyName: family, dateOfBirth: dob || undefined, force });
      if (res.ok) {
        setMessage(`Registered ${family}, ${given} — MRN ${res.mrn}.`);
        setGiven(''); setFamily(''); setDob('');
        await search(q);
      } else if (res.duplicates) {
        setDuplicates(res.duplicates.map((d) => ({ candidate: d.candidate, reasons: d.reasons })));
        setMessage('Possible duplicate(s) found — review before continuing.');
      }
    } catch {
      setMessage('Could not register — the clinic hub may be unreachable.');
    }
  };

  return (
    <section className="scr">
      <div>
        <h3 className="scr__section-title">Find a patient</h3>
        <Field
          label="Search" hint="Name, clinic number or phone — searches the local clinic record first"
          data-testid="patient-search" value={q} onChange={(e) => search(e.currentTarget.value)}
        />
        <ul data-testid="patient-results" className="scr__list" style={{ marginTop: 'var(--sancta-space-2)' }}>
          {results.map((p) => (
            <li key={p.id}>
              <button data-testid="patient-select" className="scr__list-btn sancta-focusable" onClick={() => onSelect?.(p)}>
                <strong>{p.family_name}, {p.given_name}</strong> — {p.mrn}{p.dob ? ` · DOB ${p.dob}` : ''}
              </button>
            </li>
          ))}
          {q.trim().length >= 2 && results.length === 0 ? <li><span className="scr__list-btn">No matches in the local record.</span></li> : null}
        </ul>
      </div>

      <div>
        <h3 className="scr__section-title">Register a new patient</h3>
        <div className="scr__row">
          <Field label="Given name" data-testid="reg-given" value={given} onChange={(e) => setGiven(e.currentTarget.value)} />
          <Field label="Family name" data-testid="reg-family" value={family} onChange={(e) => setFamily(e.currentTarget.value)} />
          <Field label="Date of birth" optional type="date" data-testid="reg-dob" value={dob} onChange={(e) => setDob(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <Button
            variant="primary" data-testid="reg-submit"
            {...((!given || !family) ? { disabledReason: 'Enter given and family name first' } : {})}
            onClick={() => register(false)}
          >Register patient</Button>
        </div>
      </div>

      {duplicates.length > 0 && (
        <div data-testid="dup-warning">
          <Banner tone="warning" title="Likely duplicate patient" assertive>
            <ul style={{ margin: 'var(--sancta-space-2) 0', paddingLeft: 'var(--sancta-space-6)' }}>
              {duplicates.map((d, i) => (<li key={i}>{d.candidate.family_name}, {d.candidate.given_name} ({d.candidate.mrn}) — {d.reasons.join(', ')}</li>))}
            </ul>
            <Button variant="secondary" tone="danger" data-testid="reg-force" onClick={() => register(true)}>Not a duplicate — register anyway</Button>
          </Banner>
        </div>
      )}
      <p className="scr__msg" data-testid="patients-message" role="status" aria-live="polite">{message}</p>
    </section>
  );
}
