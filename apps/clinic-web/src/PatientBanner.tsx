import { StatusTag } from '@sancta/ui';
import type { Patient } from './api.ts';

/**
 * Persistent patient identity strip (spec §4.4, EHR-001). Once a patient is active
 * it stays visible across every destination so the clinician always knows whose
 * record they are in (§3.1). When the clinic hub is unreachable a clear stale
 * indicator warns the shown record may be out of date. Rendered on the design
 * system (.sancta-strip) while preserving the established DOM contract
 * (patient-banner, banner-name, stale-indicator).
 */
export function PatientBanner({ patient, online }: { patient: Patient | null; online: boolean }) {
  if (!patient) return null;
  return (
    <section
      data-testid="patient-banner"
      className="sancta-strip"
      role="region"
      aria-label={`Patient in context: ${patient.given_name} ${patient.family_name}, clinic number ${patient.mrn}`}
    >
      <span className="sancta-strip__name" data-testid="banner-name">{patient.family_name}, {patient.given_name}</span>
      <span className="sancta-strip__id">Clinic no. {patient.mrn}</span>
      {patient.dob ? <span className="sancta-strip__meta">DOB {patient.dob}</span> : null}
      {patient.sex ? <span className="sancta-strip__meta">{patient.sex}</span> : null}
      {!online && (
        <span className="sancta-strip__alerts" data-testid="stale-indicator">
          <StatusTag tone="warning" icon="stale">Offline — record may be stale</StatusTag>
        </span>
      )}
    </section>
  );
}
