/**
 * Print/reprint of receipts, invoices and statements (BIL-007). Each issue is
 * recorded so a reprint is always visibly a COPY: the first print is the original
 * (copy 1); subsequent prints increment the copy number and the document carries
 * a COPY marker (see domain `billing-doc`). Every issue is audited.
 */
import type { Pool } from 'pg';
import {
  uuidv7,
  receiptDocument,
  invoiceDocument,
  statementDocument,
  type BillingDocument,
  type BillingDocLine,
} from '@sancta/domain';

export class BillingPrintError extends Error {}

async function nextCopyNumber(pool: Pool, kind: string, refId: string, printedBy: string | null): Promise<number> {
  const cur = await pool.query(`SELECT coalesce(max(copy_number),0) AS n FROM billing.document_print WHERE kind=$1 AND ref_id=$2`, [kind, refId]);
  const copyNumber = Number(cur.rows[0].n) + 1;
  await pool.query(
    `INSERT INTO billing.document_print (id, kind, ref_id, copy_number, printed_by) VALUES ($1,$2,$3,$4,$5)`,
    [uuidv7(), kind, refId, copyNumber, printedBy],
  );
  await pool.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'export',$3,$4,'success',$5, now(), $6)`,
    [uuidv7(), printedBy, `${kind}_print`, refId, copyNumber === 1 ? 'original' : `reprint #${copyNumber - 1}`, `${kind}-print:${refId}:${copyNumber}`],
  );
  return copyNumber;
}

async function patientOf(pool: Pool, patientId: string): Promise<{ id: string; name: string; mrn: string | null }> {
  const r = await pool.query(`SELECT id, mrn, given_name, family_name FROM identity.patient WHERE id=$1`, [patientId]);
  if (r.rows.length === 0) throw new BillingPrintError('patient not found');
  const x = r.rows[0];
  return { id: x.id, name: `${x.given_name ?? ''} ${x.family_name ?? ''}`.trim(), mrn: x.mrn };
}

/** Print (or reprint) a receipt for a confirmed payment (BIL-007). */
export async function printReceipt(pool: Pool, args: { paymentId: string; printedBy?: string; date?: string }): Promise<BillingDocument> {
  const pay = await pool.query(`SELECT receipt_number, patient_id, method, amount_minor, to_char(received_at,'YYYY-MM-DD') AS d FROM billing.payment WHERE id=$1`, [args.paymentId]);
  if (pay.rows.length === 0) throw new BillingPrintError('payment not found');
  const p = pay.rows[0];
  const patient = await patientOf(pool, p.patient_id);
  const copyNumber = await nextCopyNumber(pool, 'receipt', args.paymentId, args.printedBy ?? null);
  return receiptDocument({ reference: p.receipt_number ?? args.paymentId, patient, date: args.date ?? p.d, method: p.method, amountMinor: Number(p.amount_minor), copyNumber });
}

/** Print (or reprint) an invoice (BIL-007). */
export async function printInvoice(pool: Pool, args: { invoiceId: string; printedBy?: string; date?: string }): Promise<BillingDocument> {
  const inv = await pool.query(`SELECT invoice_number, patient_id, to_char(coalesce(finalised_at, created_at),'YYYY-MM-DD') AS d FROM billing.invoice WHERE id=$1`, [args.invoiceId]);
  if (inv.rows.length === 0) throw new BillingPrintError('invoice not found');
  const i = inv.rows[0];
  const patient = await patientOf(pool, i.patient_id);
  const linesR = await pool.query(`SELECT service_code, (applied_minor+tax_minor)::bigint AS amt FROM billing.invoice_line WHERE invoice_id=$1 ORDER BY id`, [args.invoiceId]);
  const lines: BillingDocLine[] = linesR.rows.map((l) => ({ label: l.service_code, amountMinor: Number(l.amt) }));
  const copyNumber = await nextCopyNumber(pool, 'invoice', args.invoiceId, args.printedBy ?? null);
  return invoiceDocument({ reference: i.invoice_number ?? args.invoiceId, patient, date: args.date ?? i.d, lines, copyNumber });
}

/** Print (or reprint) an account statement for a patient (BIL-007). */
export async function printStatement(pool: Pool, args: { patientId: string; printedBy?: string; date?: string }): Promise<BillingDocument> {
  const patient = await patientOf(pool, args.patientId);
  const r = await pool.query(
    `SELECT i.invoice_number,
            ( (SELECT coalesce(sum(applied_minor+tax_minor),0) FROM billing.invoice_line l WHERE l.invoice_id=i.id)
            - (SELECT coalesce(sum(amount_minor),0) FROM billing.payment_allocation a WHERE a.invoice_id=i.id) )::bigint AS outstanding
     FROM billing.invoice i WHERE i.patient_id=$1 AND i.status IN ('finalised','part_paid','paid') ORDER BY i.created_at`,
    [args.patientId],
  );
  const lines: BillingDocLine[] = r.rows
    .filter((x) => Number(x.outstanding) !== 0)
    .map((x) => ({ label: `Invoice ${x.invoice_number ?? '—'} outstanding`, amountMinor: Number(x.outstanding) }));
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const copyNumber = await nextCopyNumber(pool, 'statement', args.patientId, args.printedBy ?? null);
  return statementDocument({ reference: `STMT-${patient.mrn ?? patient.id.slice(0, 8)}`, patient, date, lines, copyNumber });
}
