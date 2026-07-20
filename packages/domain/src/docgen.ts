/**
 * Clinical document generation (EHR-011, pack §7.6). Pure functions that assemble
 * structured clinical documents — visit summary, prescription, sick note, referral
 * letter — from already-captured data. Output is a neutral structured document
 * (title + sections) the caller renders (HTML/PDF) or stores; generation itself is
 * deterministic and unit-testable. British English + DD/MM/YYYY throughout (NFR-020).
 */
import { formatDateDDMMYYYY } from './locale.ts';

export type DocSection = { heading: string; lines: string[] };
export type ClinicalDocument = {
  type: 'visit_summary' | 'prescription' | 'sick_note' | 'referral_letter';
  title: string;
  patientRef: string;
  sections: DocSection[];
};

export class DocGenError extends Error {}

export type PatientRef = { id: string; mrn: string | null; name: string };

export function visitSummary(input: {
  patient: PatientRef;
  date: string;
  clinician: string;
  reason?: string;
  diagnoses?: Array<{ display: string; certainty: string }>;
  plan?: string;
}): ClinicalDocument {
  const sections: DocSection[] = [
    { heading: 'Patient', lines: [`${input.patient.name}${input.patient.mrn ? ` (MRN ${input.patient.mrn})` : ''}`, `Visit date: ${formatDateDDMMYYYY(input.date)}`, `Seen by: ${input.clinician}`] },
  ];
  if (input.reason) sections.push({ heading: 'Presenting complaint', lines: [input.reason] });
  if (input.diagnoses?.length) sections.push({ heading: 'Diagnoses', lines: input.diagnoses.map((d) => `${d.display} (${d.certainty})`) });
  if (input.plan) sections.push({ heading: 'Plan', lines: [input.plan] });
  return { type: 'visit_summary', title: 'Visit summary', patientRef: input.patient.id, sections };
}

export function prescriptionDoc(input: {
  patient: PatientRef;
  date: string;
  prescriber: string;
  items: Array<{ drug: string; dose: string; frequency: string; duration: string }>;
}): ClinicalDocument {
  if (!input.items.length) throw new DocGenError('a prescription needs at least one item');
  const sections: DocSection[] = [
    { heading: 'Patient', lines: [`${input.patient.name}${input.patient.mrn ? ` (MRN ${input.patient.mrn})` : ''}`, `Date: ${formatDateDDMMYYYY(input.date)}`] },
    { heading: 'Prescribed items', lines: input.items.map((i) => `${i.drug} — ${i.dose}, ${i.frequency}, for ${i.duration}`) },
    { heading: 'Prescriber', lines: [input.prescriber] },
  ];
  return { type: 'prescription', title: 'Prescription', patientRef: input.patient.id, sections };
}

export function sickNote(input: {
  patient: PatientRef;
  from: string;
  to: string;
  reason: string;
  clinician: string;
}): ClinicalDocument {
  if (input.to < input.from) throw new DocGenError('sick-note end date cannot be before the start date');
  const sections: DocSection[] = [
    { heading: 'Patient', lines: [`${input.patient.name}${input.patient.mrn ? ` (MRN ${input.patient.mrn})` : ''}`] },
    { heading: 'Certified unfit for work', lines: [`From ${formatDateDDMMYYYY(input.from)} to ${formatDateDDMMYYYY(input.to)}`, `Reason: ${input.reason}`] },
    { heading: 'Certified by', lines: [input.clinician] },
  ];
  return { type: 'sick_note', title: 'Medical certificate', patientRef: input.patient.id, sections };
}

export function referralLetter(input: {
  patient: PatientRef;
  date: string;
  referrer: string;
  referTo: string;
  reason: string;
  findings?: string;
}): ClinicalDocument {
  if (!input.referTo?.trim()) throw new DocGenError('a referral needs a destination');
  const sections: DocSection[] = [
    { heading: 'To', lines: [input.referTo] },
    { heading: 'Patient', lines: [`${input.patient.name}${input.patient.mrn ? ` (MRN ${input.patient.mrn})` : ''}`, `Date: ${formatDateDDMMYYYY(input.date)}`] },
    { heading: 'Reason for referral', lines: [input.reason] },
  ];
  if (input.findings) sections.push({ heading: 'Relevant findings', lines: [input.findings] });
  sections.push({ heading: 'Referred by', lines: [input.referrer] });
  return { type: 'referral_letter', title: 'Referral letter', patientRef: input.patient.id, sections };
}
