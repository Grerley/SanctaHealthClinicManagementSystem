import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import type { Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Category = 'laboratory' | 'imaging' | 'procedure' | 'referral';
type Priority = 'routine' | 'urgent' | 'stat';
const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: 'laboratory', label: 'Laboratory' },
  { value: 'imaging', label: 'Imaging' },
  { value: 'procedure', label: 'Procedure' },
  { value: 'referral', label: 'Referral' },
];
const PRIORITIES: Array<{ value: Priority; label: string }> = [
  { value: 'routine', label: 'Routine' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'stat', label: 'STAT (immediate)' },
];
const PRIORITY_TONE: Record<Priority, 'neutral' | 'warning' | 'danger'> = { routine: 'neutral', urgent: 'warning', stat: 'danger' };

type SetItem = { category: Category; code: string; priority: Priority; indication: string };

/**
 * Reusable order sets (ORD-002). A clinician defines a named bundle of orders once
 * (POST /api/orders/set) and later applies it to the patient in context
 * (POST /api/orders/set/apply). Applying is deliberately NOT an auto-approve: every
 * item lands as an INDIVIDUAL DRAFT service request that still needs per-patient
 * review before it goes active — the set is a convenience, never a shortcut past
 * clinical judgement. Both writes are confirmed-commit (§9.2): success shows only
 * once the hub accepts, and the draft is preserved on any failure.
 */
export function OrderSets({ patient }: { patient: Patient | null }) {
  // Define draft.
  const [setCode, setSetCode] = useState('');
  const [setName, setSetName] = useState('');
  const [items, setItems] = useState<SetItem[]>([]);
  const [itemCategory, setItemCategory] = useState<Category>('laboratory');
  const [itemCode, setItemCode] = useState('');
  const [itemPriority, setItemPriority] = useState<Priority>('routine');
  const [itemIndication, setItemIndication] = useState('');
  const [defIdem, setDefIdem] = useState(newIdempotencyKey());
  const [defining, setDefining] = useState(false);
  const [defMsg, setDefMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Apply draft.
  const [applyCode, setApplyCode] = useState('');
  const [encounterId, setEncounterId] = useState('');
  const [applyIdem, setApplyIdem] = useState(newIdempotencyKey());
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);

  const addItem = () => {
    if (itemCode.trim() === '') return;
    setItems((prev) => [...prev, { category: itemCategory, code: itemCode.trim(), priority: itemPriority, indication: itemIndication.trim() }]);
    setItemCode(''); setItemIndication(''); setItemPriority('routine');
  };
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, ix) => ix !== i));

  const canDefine = setCode.trim().length > 0 && setName.trim().length > 0 && items.length > 0;

  const defineSet = async () => {
    if (!canDefine) return;
    setDefining(true); setDefMsg(null);
    const res = await mutate<{ code: string; itemCount: number }>(
      '/api/orders/set',
      {
        code: setCode.trim(),
        name: setName.trim(),
        items: items.map((it) => ({
          category: it.category,
          code: it.code,
          priority: it.priority,
          ...(it.indication ? { indication: it.indication } : {}),
        })),
      },
      { idempotencyKey: defIdem },
    );
    setDefining(false);
    if (res.ok && res.data?.code) {
      setDefMsg({ tone: 'success', text: `Saved order set “${res.data.code}” with ${res.data.itemCount} item${res.data.itemCount === 1 ? '' : 's'}. It can now be applied to a patient.` });
      setSetCode(''); setSetName(''); setItems([]); setDefIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setDefMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your draft is kept.' });
    } else {
      setDefMsg({ tone: 'danger', text: `Could not save the order set (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your draft is kept.` });
    }
  };

  const applySet = async () => {
    if (!patient || applyCode.trim() === '') return;
    setApplying(true); setApplyMsg(null);
    const res = await mutate<{ setCode: string; orderIds: string[] }>(
      '/api/orders/set/apply',
      {
        setCode: applyCode.trim(),
        patientId: patient.id,
        ...(encounterId.trim() ? { encounterId: encounterId.trim() } : {}),
      },
      { idempotencyKey: applyIdem },
    );
    setApplying(false);
    if (res.ok && res.data?.orderIds) {
      const n = res.data.orderIds.length;
      setApplyMsg({ tone: 'warning', text: `Applied “${res.data.setCode}” — ${n} order${n === 1 ? '' : 's'} created as DRAFT. Review and confirm each in Orders before it goes active.` });
      setEncounterId(''); setApplyIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setApplyMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setApplyMsg({ tone: 'danger', text: `Could not apply the order set (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  return (
    <section className="scr" aria-label="Order sets">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Order sets (ORD-002)</h3>
        <StatusTag tone={items.length > 0 ? 'action' : 'neutral'} icon={null}>{`${items.length} item${items.length === 1 ? '' : 's'} in draft`}</StatusTag>
      </div>

      <div className="scr__card" data-testid="os-define-form">
        <h3 className="scr__section-title">Define a reusable set</h3>
        <p className="scr__kpi-meta">Build a named bundle of orders. Add each item, then save the set. Saving replaces any existing set with the same code.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Set code" hint="Unique short code, e.g. SEPSIS-6" data-testid="os-set-code" value={setCode} onChange={(e) => setSetCode(e.currentTarget.value)} />
          <Field label="Set name" hint="What the bundle is for" data-testid="os-set-name" value={setName} onChange={(e) => setSetName(e.currentTarget.value)} />
        </div>

        <h4 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-3)' }}>Add an item</h4>
        <div className="scr__form-grid">
          <label className="sancta-field">
            <span className="sancta-field__label">Category</span>
            <select className="sancta-field-input" data-testid="os-item-category" value={itemCategory} onChange={(e) => setItemCategory(e.currentTarget.value as Category)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <Field label="Order code" hint="Test, study or procedure code" data-testid="os-item-code" value={itemCode} onChange={(e) => setItemCode(e.currentTarget.value)} />
          <label className="sancta-field">
            <span className="sancta-field__label">Priority</span>
            <select className="sancta-field-input" data-testid="os-item-priority" value={itemPriority} onChange={(e) => setItemPriority(e.currentTarget.value as Priority)}>
              {PRIORITIES.map((pr) => <option key={pr.value} value={pr.value}>{pr.label}</option>)}
            </select>
          </label>
          <Field label="Indication" optional hint="Default reason for this item" data-testid="os-item-indication" value={itemIndication} onChange={(e) => setItemIndication(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="secondary" data-testid="os-item-add" {...(itemCode.trim() === '' ? { disabledReason: 'Enter an order code to add' } : {})} onClick={addItem}>Add item</Button>
        </div>

        {items.length > 0 && (
          <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <table className="scr__table" data-testid="os-items">
              <caption className="sancta-visually-hidden">Order items staged in the current set draft</caption>
              <thead><tr><th scope="col">Category</th><th scope="col">Code</th><th scope="col">Priority</th><th scope="col">Indication</th><th scope="col"></th></tr></thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={`${it.category}-${it.code}-${i}`}>
                    <td>{CATEGORIES.find((c) => c.value === it.category)!.label}</td>
                    <td data-numeric>{it.code}</td>
                    <td><StatusTag tone={PRIORITY_TONE[it.priority]} icon={it.priority === 'stat' ? 'alert' : null}>{PRIORITIES.find((p) => p.value === it.priority)!.label}</StatusTag></td>
                    <td>{it.indication || '—'}</td>
                    <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" tone="danger" data-testid={`os-item-remove-${i}`} onClick={() => removeItem(i)}>Remove</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="os-define-submit" disabled={defining}
            {...(!canDefine ? { disabledReason: 'Enter a code, a name and at least one item' } : {})}
            onClick={defineSet}>Save order set</Button>
        </div>
        {defMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={defMsg.tone} assertive={defMsg.tone === 'danger'}>{defMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="os-apply-form">
        <h3 className="scr__section-title">Apply a set to the patient</h3>
        {!patient
          ? <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to apply an order set. Applied orders are attributed to a named patient.</StateBlock>
          : (
            <>
              <p className="scr__kpi-meta">Applies to ···{patient.id.slice(-8)}. Each item becomes an individual DRAFT order that still needs per-patient review before it goes active.</p>
              <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
                <Field label="Set code" hint="Code of the set to apply" data-testid="os-apply-code" value={applyCode} onChange={(e) => setApplyCode(e.currentTarget.value)} />
                <Field label="Encounter id" optional hint="Link the orders to an encounter" data-testid="os-apply-encounter" value={encounterId} onChange={(e) => setEncounterId(e.currentTarget.value)} />
              </div>
              <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
                <Button variant="primary" data-testid="os-apply-submit" disabled={applying}
                  {...(applyCode.trim() === '' ? { disabledReason: 'Enter the set code to apply' } : {})}
                  onClick={applySet}>Apply order set</Button>
              </div>
              {applyMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={applyMsg.tone} assertive={applyMsg.tone === 'danger'}>{applyMsg.text}</Banner></div>}
            </>
          )}
      </div>
    </section>
  );
}
