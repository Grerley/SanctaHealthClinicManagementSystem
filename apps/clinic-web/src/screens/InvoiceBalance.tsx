import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, money } from '../api.ts';
import './screens.css';

/** The edge computes outstanding live from invoice lines minus allocations — never a
 * stored total (§3.2). Present on BOTH backends at the same path+method:
 * worker /api/billing/invoice-outstanding GET & edge /api/billing/invoice-outstanding GET. */
type InvoiceOutstanding = { invoiceId: string; outstandingMinor: number };
const lookupInvoice = (id: string) =>
  jsonFetch<InvoiceOutstanding>(`/api/billing/invoice-outstanding?id=${encodeURIComponent(id)}`);

type Row = { invoiceId: string; outstandingMinor: number; at: string };

// An invoice with a positive balance still owes money; zero is settled; a negative
// balance is a credit (over-applied payment). Colour is never the only signal — each
// carries an icon + word (§11.3).
function balanceTone(minor: number): { tone: 'warning' | 'success' | 'info'; icon: 'alert' | 'check' | 'info'; label: string } {
  if (minor > 0) return { tone: 'warning', icon: 'alert', label: 'Outstanding' };
  if (minor === 0) return { tone: 'success', icon: 'check', label: 'Settled' };
  return { tone: 'info', icon: 'info', label: 'Credit' };
}

/**
 * Invoice balance inspector (BIL-006). Looks up the live outstanding balance for one
 * or more invoice references before a payment run or a settlement, and keeps a
 * running total of everything still owed across the invoices checked. The figure is
 * derived by the hub from the invoice lines minus the applied allocations, so it is
 * always current and never an editable stored total (§3.2). This is a read-only
 * lookup: it is triggered by the operator (never on mount), so it carries no
 * edge-schema id risk — an unknown or malformed reference simply surfaces as "could
 * not look up", it never freezes the screen.
 */
export function InvoiceBalance() {
  const [ref, setRef] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'danger' | 'warning'; text: string } | null>(null);

  const canLookup = ref.trim().length > 0;

  const add = async () => {
    const id = ref.trim();
    if (!id) return;
    setBusy(true); setMsg(null);
    try {
      const r = await lookupInvoice(id);
      // De-duplicate: re-checking an invoice refreshes its row rather than stacking.
      setRows((prev) => [
        { invoiceId: r.invoiceId, outstandingMinor: r.outstandingMinor, at: new Date().toISOString().slice(11, 19) },
        ...prev.filter((x) => x.invoiceId !== r.invoiceId),
      ]);
      setRef('');
    } catch {
      setMsg({ tone: 'danger', text: `Could not look up invoice ···${id.slice(-8)}. Check the reference, or the clinic hub may be unreachable — nothing was changed.` });
    } finally {
      setBusy(false);
    }
  };

  const totalOwed = rows.reduce((s, r) => s + Math.max(0, r.outstandingMinor), 0);
  const totalCredit = rows.reduce((s, r) => s + Math.min(0, r.outstandingMinor), 0);

  return (
    <section className="scr" aria-label="Invoice balance inspector">
      <div className="scr__card" data-testid="inv-lookup">
        <h3 className="scr__section-title">Look up outstanding balance (BIL-006)</h3>
        <p className="scr__kpi-meta">Enter an invoice reference from a printed invoice or checkout receipt. The hub returns the balance still owed, computed live from the invoice lines minus applied payments.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Invoice reference" hint="The invoice id or number" data-testid="inv-ref" value={ref}
            onChange={(e) => setRef(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canLookup && !busy) void add(); }}
            style={{ minWidth: 280 }} />
          <Button variant="primary" data-testid="inv-lookup-submit" disabled={busy}
            {...(!canLookup ? { disabledReason: 'Enter an invoice reference' } : {})}
            onClick={add}>Check balance</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      {rows.length > 0 && (
        <div className="scr__kpi-grid">
          <div className="scr__kpi">
            <span className="scr__kpi-label">Still owed (checked)</span>
            <span className="scr__kpi-value" data-testid="inv-total-owed">{money(totalOwed)}</span>
            <span className="scr__kpi-meta">{rows.length} invoice{rows.length === 1 ? '' : 's'} checked</span>
          </div>
          {totalCredit < 0 && (
            <div className="scr__kpi">
              <span className="scr__kpi-label">Credit balances</span>
              <span className="scr__kpi-value">{money(Math.abs(totalCredit))}</span>
              <span className="scr__kpi-meta"><StatusTag tone="info" icon="info">Over-applied</StatusTag></span>
            </div>
          )}
        </div>
      )}

      {rows.length === 0
        ? <StateBlock state="empty" title="No invoices checked yet">Look up an invoice reference above to see its outstanding balance.</StateBlock>
        : (
          <div className="scr__table-scroll">
            <table className="scr__table" data-testid="inv-rows">
              <caption className="sancta-visually-hidden">Invoices checked in this session with their live outstanding balance, most recent first.</caption>
              <thead><tr><th scope="col">Invoice</th><th scope="col">Checked at</th><th scope="col">State</th><th scope="col" style={{ textAlign: 'right' }}>Outstanding</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const b = balanceTone(r.outstandingMinor);
                  return (
                    <tr key={r.invoiceId}>
                      <td data-numeric>···{r.invoiceId.slice(-8)}</td>
                      <td data-numeric>{r.at}</td>
                      <td><StatusTag tone={b.tone} icon={b.icon}>{b.label}</StatusTag></td>
                      <td data-numeric style={{ textAlign: 'right' }}>{money(r.outstandingMinor)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
