/**
 * Persistent patient identity strip (spec §4.4). Kept visible during clinical,
 * dispensing, document-release and refund work (§3.1). Shows primary identity
 * (name + clinic number — never truncate both), secondary identifiers, encounter
 * context and serious alerts (alerts only to authorised roles). Estimated DOB is
 * labelled wherever age is shown. Photo/colour are never the sole identity check.
 */
import type { JSX } from 'react';
import { StatusTag } from './StatusTag.tsx';

export type PatientAlert = { kind: 'allergy' | 'identity' | 'safeguarding' | 'infection'; label: string };

export type PatientStripData = {
  displayName: string;
  clinicNumber: string;
  dateOfBirth?: string;      // ISO; may be estimated
  dobEstimated?: boolean;
  age?: string;
  sex?: string;
  identifierEnding?: string; // last few digits only — never the full national id
  encounter?: { visitDate?: string; location?: string; clinician?: string; workflowState?: string };
  alerts?: PatientAlert[];
  /** Whether the viewer's role may see clinical alerts (§4.4). */
  canSeeAlerts?: boolean;
};

const ALERT_TONE = { allergy: 'danger', identity: 'warning', safeguarding: 'danger', infection: 'warning' } as const;

export function PatientIdentityStrip({ patient }: { patient: PatientStripData }): JSX.Element {
  const { displayName, clinicNumber, dateOfBirth, dobEstimated, age, sex, identifierEnding, encounter, alerts, canSeeAlerts } = patient;
  return (
    <section className="sancta-strip" aria-label={`Patient in context: ${displayName}, clinic number ${clinicNumber}`} data-testid="patient-strip">
      <span className="sancta-strip__name">{displayName}</span>
      <span className="sancta-strip__id">Clinic no. {clinicNumber}</span>
      {(dateOfBirth || age) && (
        <span className="sancta-strip__meta">
          {dateOfBirth ? `DOB ${dateOfBirth}` : ''}{dobEstimated ? ' (estimated)' : ''}
          {age ? `${dateOfBirth ? ' · ' : ''}${age}${dobEstimated ? ' (est.)' : ''}` : ''}
          {sex ? ` · ${sex}` : ''}
        </span>
      )}
      {identifierEnding ? <span className="sancta-strip__meta">ID ···{identifierEnding}</span> : null}
      {encounter && (encounter.visitDate || encounter.location || encounter.clinician || encounter.workflowState) ? (
        <span className="sancta-strip__meta">
          {[encounter.visitDate, encounter.location, encounter.clinician, encounter.workflowState].filter(Boolean).join(' · ')}
        </span>
      ) : null}
      {canSeeAlerts && alerts && alerts.length > 0 ? (
        <span className="sancta-strip__alerts">
          {alerts.map((a, i) => <StatusTag key={i} tone={ALERT_TONE[a.kind]}>{a.label}</StatusTag>)}
        </span>
      ) : null}
    </section>
  );
}

/**
 * The two-identifier tuple a high-risk confirmation surface must present (§3.1,
 * §4.4). Returns the two strongest available identifiers (name is not counted as an
 * identifier on its own). Throws-free: returns what it can, and `sufficient` says
 * whether two independent identifiers are present.
 */
export function twoIdentifiers(patient: PatientStripData): { identifiers: string[]; sufficient: boolean } {
  const ids: string[] = [];
  if (patient.clinicNumber) ids.push(`Clinic no. ${patient.clinicNumber}`);
  if (patient.dateOfBirth) ids.push(`DOB ${patient.dateOfBirth}${patient.dobEstimated ? ' (estimated)' : ''}`);
  if (patient.identifierEnding) ids.push(`ID ending ${patient.identifierEnding}`);
  return { identifiers: ids.slice(0, 2), sufficient: ids.length >= 2 };
}
