/**
 * Billing document builders — receipts, invoices, statements (BIL-007, pack §10).
 * A reprint must be visibly marked so an original and a copy are never confused:
 * the first issue (copy 1) is the ORIGINAL; any later issue carries a COPY marker
 * with its reprint number. Pure formatting over already-computed figures (minor
 * currency units); British DD/MM/YYYY.
 */
import { formatDateDDMMYYYY } from './locale.ts';

export type BillingDocLine = { label: string; amountMinor: number };
export type BillingDocument = {
  kind: 'receipt' | 'invoice' | 'statement';
  title: string;
  reference: string;
  patientRef: string;
  date: string;
  lines: BillingDocLine[];
  totalMinor: number;
  copyNumber: number;
  copyMarker: string | null; // null on the original; "COPY (reprint #N)" otherwise
};

/** The copy marker for a given issue number — null for the original (BIL-007). */
export function copyMarker(copyNumber: number): string | null {
  return copyNumber <= 1 ? null : `COPY (reprint #${copyNumber - 1})`;
}

export function receiptDocument(input: {
  reference: string;
  patient: { id: string; name: string; mrn: string | null };
  date: string;
  method: string;
  amountMinor: number;
  copyNumber: number;
}): BillingDocument {
  return {
    kind: 'receipt',
    title: 'Receipt',
    reference: input.reference,
    patientRef: input.patient.id,
    date: formatDateDDMMYYYY(input.date),
    lines: [{ label: `Payment received (${input.method})`, amountMinor: input.amountMinor }],
    totalMinor: input.amountMinor,
    copyNumber: input.copyNumber,
    copyMarker: copyMarker(input.copyNumber),
  };
}

export function invoiceDocument(input: {
  reference: string;
  patient: { id: string; name: string; mrn: string | null };
  date: string;
  lines: BillingDocLine[];
  copyNumber: number;
}): BillingDocument {
  const totalMinor = input.lines.reduce((s, l) => s + l.amountMinor, 0);
  return {
    kind: 'invoice',
    title: 'Invoice',
    reference: input.reference,
    patientRef: input.patient.id,
    date: formatDateDDMMYYYY(input.date),
    lines: input.lines,
    totalMinor,
    copyNumber: input.copyNumber,
    copyMarker: copyMarker(input.copyNumber),
  };
}

export function statementDocument(input: {
  reference: string;
  patient: { id: string; name: string; mrn: string | null };
  date: string;
  lines: BillingDocLine[];
  copyNumber: number;
}): BillingDocument {
  const totalMinor = input.lines.reduce((s, l) => s + l.amountMinor, 0);
  return {
    kind: 'statement',
    title: 'Account statement',
    reference: input.reference,
    patientRef: input.patient.id,
    date: formatDateDDMMYYYY(input.date),
    lines: input.lines,
    totalMinor,
    copyNumber: input.copyNumber,
    copyMarker: copyMarker(input.copyNumber),
  };
}
