import { useEffect, useState } from 'react';
import { Banner, Button, StatusTag, StateBlock } from '@sancta/ui';
import { api, type Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * Duplicate detection & merge (PAT-008). A merge is never silent: the operator fixes
 * the surviving record, the hub proposes look-alike candidates (same family name /
 * DOB / given name), and the operator confirms the exact pair before the reversible
 * merge runs. The scan is a plain search read (present on both backends); the merge
 * is a confirmed-commit write (§9.2) — success only on res.ok, draft (the chosen
 * pair) preserved on failure, fresh idempotency key per attempt. Both the search and
 * /api/patients/merge exist on the worker and edge backends.
 */
type Candidate = { patient: Patient; reasons: string[] };

function matchReasons(survivor: Patient, other: Patient): string[] {
  const reasons: string[] = [];
  const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== '';
  if (eq(survivor.family_name, other.family_name)) reasons.push('same family name');
  if (eq(survivor.given_name, other.given_name)) reasons.push('same given name');
  if (survivor.dob && eq(survivor.dob, other.dob)) reasons.push('same date of birth');
  if (survivor.sex && eq(survivor.sex, other.sex)) reasons.push('same sex');
  return reasons;
}

export function PatientMerge({ patient }: { patient: Patient | null }) {
  const [survivor, setSurvivor] = useState<Patient | null>(patient);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'ready' | 'error'>('idle');
  const [duplicate, setDuplicate] = useState<Patient | null>(null);

  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Keep the survivor in step with the patient in context until the operator picks one.
  useEffect(() => { setSurvivor(patient); }, [patient]);

  const scan = async (s: Patient) => {
    setScanState('scanning'); setCandidates([]); setDuplicate(null);
    try {
      const res = await api.searchPatients(s.family_name || s.mrn);
      const found = res.patients
        .filter((c) => c.id !== s.id)
        .map((c) => ({ patient: c, reasons: matchReasons(s, c) }))
        .filter((c) => c.reasons.length > 0)
        .sort((a, b) => b.reasons.length - a.reasons.length);
      setCandidates(found);
      setScanState('ready');
    } catch {
      setScanState('error');
    }
  };

  const merge = async () => {
    if (!survivor || !duplicate) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ mergeId: string; movedRecords: number }>(
      '/api/patients/merge',
      { survivorId: survivor.id, mergedId: duplicate.id, mergedBy: 'demo-operator' },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.mergeId) {
      setMsg({ tone: 'success', text: `Merged ${duplicate.mrn} into ${survivor.mrn}. ${res.data.movedRecords} record(s) repointed. Reference ···${res.data.mergeId.slice(-8)}.` });
      setDuplicate(null); setCandidates([]); setScanState('idle'); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. No merge was performed — the selected pair is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Merge rejected (${res.errorCode ?? 'error'}). The selected pair is kept.` });
    }
  };

  if (!patient) {
    return <StateBlock state="permission-limited" title="No patient in context">Select the surviving patient from the Patients screen to scan for duplicates to merge into it.</StateBlock>;
  }

  return (
    <section className="scr" data-testid="merge" aria-label="Patient duplicate detection and merge">
      <div className="scr__card" data-testid="merge-survivor">
        <h3 className="scr__section-title">Surviving record</h3>
        <p className="scr__kpi-meta">All references from the duplicate will be repointed to this record. The merge is reversible by authorised support.</p>
        {survivor && (
          <p style={{ marginTop: 'var(--sancta-space-2)' }}>
            <strong>{survivor.family_name}, {survivor.given_name}</strong> — {survivor.mrn}{survivor.dob ? ` · DOB ${survivor.dob}` : ''}
          </p>
        )}
        <div className="scr__row" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="merge-scan" disabled={scanState === 'scanning'}
            onClick={() => survivor && scan(survivor)}>Scan for likely duplicates</Button>
        </div>
      </div>

      {scanState === 'scanning' && <StateBlock state="initial-loading" title="Scanning for duplicates" />}
      {scanState === 'error' && <StateBlock state="stale" title="Scan unavailable">The clinic hub may be unreachable.</StateBlock>}

      {scanState === 'ready' && (
        <div>
          <h3 className="scr__section-title">Likely duplicates</h3>
          {candidates.length === 0
            ? <StateBlock state="empty" title="No look-alike records found">No other record shares this patient’s name or date of birth.</StateBlock>
            : (
              <div className="scr__table-scroll">
                <table className="scr__table" data-testid="merge-candidates">
                  <caption className="sancta-visually-hidden">Records that look like duplicates of the surviving record</caption>
                  <thead>
                    <tr><th scope="col">Patient</th><th scope="col">MRN</th><th scope="col">Why it matched</th><th scope="col">Select</th></tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => {
                      const selected = duplicate?.id === c.patient.id;
                      return (
                        <tr key={c.patient.id} aria-selected={selected}>
                          <td>{c.patient.family_name}, {c.patient.given_name}{c.patient.dob ? ` · ${c.patient.dob}` : ''}</td>
                          <td data-numeric>{c.patient.mrn}</td>
                          <td><StatusTag tone="warning" icon="alert">{c.reasons.join(', ')}</StatusTag></td>
                          <td>
                            <Button variant={selected ? 'primary' : 'secondary'} data-testid="merge-pick" onClick={() => setDuplicate(selected ? null : c.patient)}>
                              {selected ? 'Selected' : 'Select as duplicate'}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      {duplicate && survivor && (
        <div className="scr__card" data-testid="merge-confirm">
          <Banner tone="warning" title="Confirm the merge" assertive>
            Merge <strong>{duplicate.family_name}, {duplicate.given_name} ({duplicate.mrn})</strong> into
            {' '}<strong>{survivor.family_name}, {survivor.given_name} ({survivor.mrn})</strong>. The duplicate is preserved and marked merged; this can be reversed.
          </Banner>
          <div className="scr__row" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" tone="danger" data-testid="merge-submit" disabled={busy}
              onClick={merge}>Merge records</Button>
          </div>
        </div>
      )}

      {msg && <Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner>}
    </section>
  );
}
