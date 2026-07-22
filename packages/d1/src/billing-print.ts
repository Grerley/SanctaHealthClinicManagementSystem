/**
 * Print/reprint of receipts, invoices and statements on D1 (BIL-007). Each issue
 * is recorded so a reprint is always visibly a COPY: the first print is the
 * original (copy 1); subsequent prints increment the copy number and the document
 * carries a COPY marker (domain `billing-doc`). Every issue is audited. Ported
 * from the Postgres edge `billing-print.ts`.
 *
 * D1 translations: running copy number via COALESCE(MAX)+1; a UNIQUE(kind,ref_id,
 * copy_number) index is the lock-free gate — a concurrent reprint that would mint
 * the same number hits the constraint and retries.
 */
import { uuidv7, receiptDocument, invoiceDocument, statementDocument, type BillingDocument, type BillingDocLine } from '@sancta/domain';
import type { D1Database } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class BillingPrintError extends Error {}

async function nextCopyNumber(db: D1Database, kind: string, refId: string, printedBy: string | null): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await one<{ n: number }>(db, `SELECT COALESCE(MAX(copy_number),0) AS n FROM billing_document_print WHERE kind=? AND ref_id=?`, [kind, refId]);
    const copyNumber = Number(cur?.n ?? 0) + 1;
    try {
      await db.batch([
        stmt(db, `INSERT INTO billing_document_print (id, kind, ref_id, copy_number, printed_by) VALUES (?,?,?,?,?)`, [uuidv7(), kind, refId, copyNumber, printedBy]),
        stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'export',?,?,'success',?,?)`,
          [uuidv7(), printedBy, `${kind}_print`, refId, copyNumber === 1 ? 'original' : `reprint #${copyNumber - 1}`, `${kind}-print:${refId}:${copyNumber}`]),
      ]);
      return copyNumber;
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) continue; // lost the race — recompute and retry
      throw e;
    }
  }
  throw new BillingPrintError('could not allocate a copy number (too much contention)');
}

async function patientOf(db: D1Database, patientId: string): Promise<{ id: string; name: string; mrn: string | null }> {
  const x = await one<{ id: string; mrn: string | null; given_name: string | null; family_name: string | null }>(db, `SELECT id, mrn, given_name, family_name FROM identity_patient WHERE id=?`, [patientId]);
  if (!x) throw new BillingPrintError('patient not found');
  return { id: x.id, name: `${x.given_name ?? ''} ${x.family_name ?? ''}`.trim(), mrn: x.mrn };
}

/** Print (or reprint) a receipt for a confirmed payment (BIL-007). */
export async function printReceipt(db: D1Database, args: { paymentId: string; printedBy?: string; date?: string }): Promise<BillingDocument> {
  const p = await one<{ receipt_number: string | null; patient_id: string; method: string; amount_minor: number; received_at: string }>(db,
    `SELECT receipt_number, patient_id, method, amount_minor, received_at FROM billing_payment WHERE id=?`, [args.paymentId]);
  if (!p) throw new BillingPrintError('payment not found');
  const patient = await patientOf(db, p.patient_id);
  const copyNumber = await nextCopyNumber(db, 'receipt', args.paymentId, args.printedBy ?? null);
  return receiptDocument({ reference: p.receipt_number ?? args.paymentId, patient, date: args.date ?? p.received_at.slice(0, 10), method: p.method, amountMinor: Number(p.amount_minor), copyNumber });
}

/** Print (or reprint) an invoice (BIL-007). */
export async function printInvoice(db: D1Database, args: { invoiceId: string; printedBy?: string; date?: string }): Promise<BillingDocument> {
  const i = await one<{ invoice_number: string | null; patient_id: string; d: string }>(db,
    `SELECT invoice_number, patient_id, COALESCE(finalised_at, created_at) AS d FROM billing_invoice WHERE id=?`, [args.invoiceId]);
  if (!i) throw new BillingPrintError('invoice not found');
  const patient = await patientOf(db, i.patient_id);
  const lineRows = await many<{ service_code: string; amt: number }>(db,
    `SELECT service_code, (applied_minor+tax_minor) AS amt FROM billing_invoice_line WHERE invoice_id=? ORDER BY id`, [args.invoiceId]);
  const lines: BillingDocLine[] = lineRows.map((l) => ({ label: l.service_code, amountMinor: Number(l.amt) }));
  const copyNumber = await nextCopyNumber(db, 'invoice', args.invoiceId, args.printedBy ?? null);
  return invoiceDocument({ reference: i.invoice_number ?? args.invoiceId, patient, date: args.date ?? i.d.slice(0, 10), lines, copyNumber });
}

/** Print (or reprint) an account statement for a patient (BIL-007). */
export async function printStatement(db: D1Database, args: { patientId: string; printedBy?: string; date?: string }): Promise<BillingDocument> {
  const patient = await patientOf(db, args.patientId);
  const rows = await many<{ invoice_number: string | null; outstanding: number }>(db,
    `SELECT i.invoice_number,
            ( (SELECT COALESCE(SUM(applied_minor+tax_minor),0) FROM billing_invoice_line l WHERE l.invoice_id=i.id)
            - (SELECT COALESCE(SUM(amount_minor),0) FROM billing_payment_allocation a WHERE a.invoice_id=i.id) ) AS outstanding
     FROM billing_invoice i WHERE i.patient_id=? AND i.status IN ('finalised','part_paid','paid') ORDER BY i.created_at`,
    [args.patientId]);
  const lines: BillingDocLine[] = rows
    .filter((x) => Number(x.outstanding) !== 0)
    .map((x) => ({ label: `Invoice ${x.invoice_number ?? '—'} outstanding`, amountMinor: Number(x.outstanding) }));
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const copyNumber = await nextCopyNumber(db, 'statement', args.patientId, args.printedBy ?? null);
  return statementDocument({ reference: `STMT-${patient.mrn ?? patient.id.slice(0, 8)}`, patient, date, lines, copyNumber });
}
