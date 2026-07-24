import { useState } from 'react';
import { Banner, Button, Field, Icon } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * Expense capture (FIN-011). Records an operating expense as a payable. Money is entered
 * in major units and transported in minor units. Confirmed-commit write (§9.2): the
 * draft is preserved on failure.
 */
export function FinanceExpense() {
  const [category, setCategory] = useState('');
  const [supplier, setSupplier] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [idem, setIdem] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const amountOk = /^\d+(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) > 0;
  const ready = category.trim() !== '' && amountOk;

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ expenseId: string; payableId: string }>(
      '/api/finance/expense',
      {
        category: category.trim(), amountMinor: Math.round(Number(amount) * 100),
        ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
        ...(dueDate.trim() ? { dueDate } : {}),
      },
      { idempotencyKey: idem },
    );
    setBusy(false);
    if (res.ok && res.data) {
      setMsg({ tone: 'success', text: `Captured $${Number(amount).toFixed(2)} expense. Payable ···${res.data.payableId.slice(-8)}.` });
      setCategory(''); setSupplier(''); setAmount(''); setDueDate(''); setIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not capture the expense (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Expense capture">
      <div className="scr__card" data-testid="expense-form">
        <h3 className="scr__section-title">Capture an expense</h3>
        <p className="scr__kpi-meta">Records the expense and raises a payable. Enter the amount in dollars and cents.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Category" hint="Expense category" data-testid="expense-category" value={category} onChange={(e) => setCategory(e.currentTarget.value)} />
          <Field label="Supplier" optional hint="Who is being paid" data-testid="expense-supplier" value={supplier} onChange={(e) => setSupplier(e.currentTarget.value)} />
          <Field label="Amount" numeric prefix="$" hint="Dollars and cents" data-testid="expense-amount" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} />
          <Field label="Due date" optional type="date" hint="When it falls due" data-testid="expense-due" value={dueDate} onChange={(e) => setDueDate(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="expense-submit" disabled={busy}
            {...(category.trim() === '' ? { disabledReason: 'Enter a category' } : !amountOk ? { disabledReason: 'Enter a positive amount' } : {})}
            onClick={submit}>Capture expense</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
