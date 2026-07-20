import type { Patient } from './api.ts';

/**
 * Persistent patient banner (EHR-001). Once a patient is active it stays visible
 * across every tab so the clinician always knows whose record they are in. When
 * offline, a clear stale indicator warns that the shown record may be out of date.
 */
export function PatientBanner({ patient, online }: { patient: Patient | null; online: boolean }) {
  if (!patient) return null;
  return (
    <div
      data-testid="patient-banner"
      role="region"
      aria-label="Active patient"
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '8px 0', padding: '8px 12px', background: '#eef2ff', borderRadius: 8, border: '1px solid #c7d2fe' }}
    >
      <strong data-testid="banner-name">{patient.family_name}, {patient.given_name}</strong>
      <span style={{ color: '#3730a3' }}>MRN {patient.mrn}</span>
      {patient.dob ? <span style={{ color: '#3730a3' }}>DOB {patient.dob}</span> : null}
      {!online && (
        <span data-testid="stale-indicator" style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 12, background: '#fef3c7', color: '#92400e', fontSize: 13 }}>
          ⚠ Offline — record may be stale
        </span>
      )}
    </div>
  );
}
