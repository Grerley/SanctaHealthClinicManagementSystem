import { useEffect, useMemo, useState } from 'react';
import { StatusTag, StateBlock, Banner } from '@sancta/ui';
import { api, type Patient } from '../api.ts';
import './screens.css';

/**
 * Patient demographics — authoritative view + provenance/freshness check (PAT-002).
 * The patient carried in context is a snapshot taken when it was selected; this
 * screen re-reads the authoritative record from the clinic hub and shows, field by
 * field, whether the in-context copy still matches. Drift is surfaced honestly (not
 * colour alone) so an operator never edits or acts on a stale identity. Read-only:
 * the demographic-change endpoint is not uniformly available across both backends
 * (see report), so no edit is offered here rather than a stub that can't commit.
 */
type FieldRow = { key: string; label: string; context: string; authoritative: string };

export function PatientDemographics({ patient }: { patient: Patient | null }) {
  const [record, setRecord] = useState<Patient | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'missing'>('loading');

  useEffect(() => {
    if (!patient) { setState('ready'); return; }
    setState('loading');
    void (async () => {
      try {
        // Re-read the authoritative record by MRN and match on identity id.
        const res = await api.searchPatients(patient.mrn);
        const found = res.patients.find((p) => p.id === patient.id) ?? null;
        setRecord(found);
        setState(found ? 'ready' : 'missing');
      } catch {
        setState('error');
      }
    })();
  }, [patient]);

  const rows: FieldRow[] = useMemo(() => {
    if (!patient || !record) return [];
    const norm = (v: string | null | undefined) => (v ?? '').trim();
    return [
      { key: 'mrn', label: 'MRN', context: norm(patient.mrn), authoritative: norm(record.mrn) },
      { key: 'given', label: 'Given name', context: norm(patient.given_name), authoritative: norm(record.given_name) },
      { key: 'family', label: 'Family name', context: norm(patient.family_name), authoritative: norm(record.family_name) },
      { key: 'dob', label: 'Date of birth', context: norm(patient.dob), authoritative: norm(record.dob) },
      { key: 'sex', label: 'Sex', context: norm(patient.sex), authoritative: norm(record.sex) },
    ];
  }, [patient, record]);

  const drift = rows.filter((r) => r.context !== r.authoritative);

  if (!patient) {
    return <StateBlock state="permission-limited" title="No patient in context">Select a patient from the Patients screen to view their demographics.</StateBlock>;
  }
  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading demographics">Re-reading the authoritative record from the clinic hub…</StateBlock>;
  if (state === 'error') return <StateBlock state="stale" title="Demographics unavailable">The clinic hub may be unreachable. Showing nothing rather than an unverified record.</StateBlock>;
  if (state === 'missing') {
    return (
      <StateBlock state="empty" title="Record not returned by the hub">
        The selected patient (MRN {patient.mrn}) was not found in the authoritative search. It may have been merged into another record.
      </StateBlock>
    );
  }

  return (
    <section className="scr" data-testid="demographics" aria-label={`Demographics for ${patient.given_name} ${patient.family_name}`}>
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Demographics — {patient.family_name}, {patient.given_name}</h3>
        <StatusTag tone={drift.length === 0 ? 'success' : 'warning'} icon={drift.length === 0 ? 'check' : 'alert'}>
          {drift.length === 0 ? 'In-context copy is current' : `${drift.length} field${drift.length === 1 ? '' : 's'} changed since selected`}
        </StatusTag>
      </div>

      {drift.length > 0 && (
        <Banner tone="warning" title="The record changed since you selected this patient" assertive>
          Re-select the patient from Patients to refresh the identity strip before acting on the fields marked changed.
        </Banner>
      )}

      <div className="scr__table-scroll">
        <table className="scr__table" data-testid="demographics-table">
          <caption className="sancta-visually-hidden">Patient demographic fields: value in context compared with the authoritative record</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">In context</th>
              <th scope="col">Authoritative (hub)</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const changed = r.context !== r.authoritative;
              return (
                <tr key={r.key} data-testid={`demographics-row-${r.key}`}>
                  <td>{r.label}</td>
                  <td>{r.context || '—'}</td>
                  <td>{r.authoritative || '—'}</td>
                  <td>
                    <StatusTag tone={changed ? 'warning' : 'neutral'} icon={changed ? 'alert' : 'check'}>
                      {changed ? 'Changed' : 'Matches'}
                    </StatusTag>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="scr__kpi-meta">Read-only view. Demographic corrections are made through the registration desk workflow.</p>
    </section>
  );
}
