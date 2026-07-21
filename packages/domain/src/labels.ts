/**
 * Patient-safe specimen/procedure labels (ORD-004, pack §6.4). A label that
 * travels with a sample must carry a positive-identification set that is unique
 * and unambiguous, WITHOUT printing full identity that would breach privacy if
 * the label is seen by others. We put the accession number, the patient's
 * initials, date of birth and sex — never the full name. Deriving initials here
 * (rather than accepting a name) makes it structurally impossible to leak the
 * full name onto a label. British DD/MM/YYYY.
 */
import { formatDateDDMMYYYY } from './locale.ts';

/** Initials from a full name — the only identity fragment allowed on a label. */
export function initialsOf(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export type SpecimenLabel = { accession: string; line1: string; line2: string; line3: string };

/**
 * Build a patient-safe specimen label (ORD-004). Carries accession + order code,
 * initials + DOB + sex, and the collection date — enough for positive ID at the
 * bench, but no full name or full record number.
 */
export function specimenLabel(args: {
  accession: string;
  initials: string;
  dob: string; // ISO date
  sex: string;
  orderCode: string;
  collectedOn: string; // ISO date
}): SpecimenLabel {
  return {
    accession: args.accession,
    line1: `${args.accession}  ${args.orderCode}`,
    line2: `${args.initials}  ${formatDateDDMMYYYY(args.dob)}  ${args.sex}`,
    line3: `Collected ${formatDateDDMMYYYY(args.collectedOn)}`,
  };
}

/** Format a numeric accession as a zero-padded, prefixed label id (e.g. SPN-000123). */
export function formatAccession(seq: number, prefix = 'SPN'): string {
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}
