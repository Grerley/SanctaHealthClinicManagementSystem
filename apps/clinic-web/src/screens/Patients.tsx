import { useEffect, useState } from 'react';
import { api, type Patient } from '../api.ts';

export function Patients() {
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
      setMessage('Could not register — the edge hub may be unreachable.');
    }
  };

  return (
    <section>
      <h2 style={{ fontSize: 16 }}>Find a patient</h2>
      <input data-testid="patient-search" placeholder="Search name, MRN or phone" value={q} onChange={(e) => search(e.target.value)} style={{ width: '100%', padding: 8 }} />
      <ul data-testid="patient-results" style={{ listStyle: 'none', padding: 0, marginTop: 8 }}>
        {results.map((p) => (
          <li key={p.id} style={{ padding: 8, borderBottom: '1px solid #eee' }}>
            <strong>{p.family_name}, {p.given_name}</strong> — {p.mrn}{p.dob ? ` · DOB ${p.dob}` : ''}
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 16, marginTop: 20 }}>Register a new patient</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input data-testid="reg-given" placeholder="Given name" value={given} onChange={(e) => setGiven(e.target.value)} style={{ padding: 8 }} />
        <input data-testid="reg-family" placeholder="Family name" value={family} onChange={(e) => setFamily(e.target.value)} style={{ padding: 8 }} />
        <input data-testid="reg-dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} style={{ padding: 8 }} />
        <button data-testid="reg-submit" disabled={!given || !family} onClick={() => register(false)} style={{ padding: '8px 14px', background: '#0b5', color: '#fff', border: 0, borderRadius: 6 }}>Register</button>
      </div>

      {duplicates.length > 0 && (
        <div data-testid="dup-warning" style={{ marginTop: 12, padding: 12, background: '#fef3c7', borderRadius: 8 }}>
          <strong>Likely duplicates:</strong>
          <ul>{duplicates.map((d, i) => (<li key={i}>{d.candidate.family_name}, {d.candidate.given_name} ({d.candidate.mrn}) — {d.reasons.join(', ')}</li>))}</ul>
          <button data-testid="reg-force" onClick={() => register(true)} style={{ padding: '6px 12px' }}>Not a duplicate — register anyway</button>
        </div>
      )}
      <p data-testid="patients-message" role="status" aria-live="polite" style={{ marginTop: 12, minHeight: 20 }}>{message}</p>
    </section>
  );
}
