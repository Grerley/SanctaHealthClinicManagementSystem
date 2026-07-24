import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag } from '@sancta/ui';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

type Proposal = { medicineCode: string; dose?: string; frequency?: string };

/** Parse one "medicineCode | substanceCode | dose | frequency" line into a template item. */
function parseItem(line: string): { medicineCode: string; substanceCode: string; dose?: string; frequency?: string } | null {
  const parts = line.split('|').map((s) => s.trim());
  const medicineCode = parts[0] ?? '';
  const substanceCode = parts[1] ?? '';
  if (medicineCode === '' || substanceCode === '') return null;
  const dose = parts[2] ?? '';
  const frequency = parts[3] ?? '';
  return { medicineCode, substanceCode, ...(dose ? { dose } : {}), ...(frequency ? { frequency } : {}) };
}

/**
 * Prescription templates (MED-004). Define a reusable prescribing protocol, then apply
 * it to produce prescribing proposals for review — applying NEVER writes prescriptions
 * directly; it returns proposals a prescriber confirms. Defining is a confirmed-commit
 * write (§9.2).
 */
export function RxTemplates() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [itemsText, setItemsText] = useState('');
  const [defIdem, setDefIdem] = useState(newIdempotencyKey());
  const [defining, setDefining] = useState(false);
  const [defMsg, setDefMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [applyCode, setApplyCode] = useState('');
  const [applyIdem, setApplyIdem] = useState(newIdempotencyKey());
  const [applying, setApplying] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [applyMsg, setApplyMsg] = useState<{ tone: 'danger'; text: string } | null>(null);

  const items = itemsText.split('\n').map(parseItem).filter((x): x is NonNullable<typeof x> => x !== null);
  const defReady = code.trim() !== '' && name.trim() !== '' && items.length > 0;

  const define = async () => {
    if (!defReady) return;
    setDefining(true); setDefMsg(null);
    const res = await mutate<{ code: string; itemCount: number }>(
      '/api/prescribe/template',
      { code: code.trim(), name: name.trim(), items },
      { idempotencyKey: defIdem },
    );
    setDefining(false);
    if (res.ok && res.data) {
      setDefMsg({ tone: 'success', text: `Saved template ${res.data.code} with ${res.data.itemCount} item(s).` });
      setDefIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setDefMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected. Your entry is kept.' });
    } else {
      setDefMsg({ tone: 'danger', text: `Could not save the template (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your entry is kept.` });
    }
  };

  const apply = async () => {
    if (applyCode.trim() === '') return;
    setApplying(true); setApplyMsg(null); setProposals(null);
    const res = await mutate<{ templateCode: string; proposals: Proposal[] }>(
      '/api/prescribe/template/apply',
      { templateCode: applyCode.trim() },
      { idempotencyKey: applyIdem },
    );
    setApplying(false);
    if (res.ok && res.data) { setProposals(res.data.proposals); setApplyIdem(newIdempotencyKey()); }
    else if (res.errorCode === 'network') setApplyMsg({ tone: 'danger', text: 'Could not reach the clinic hub — nothing changed; retry when connected.' });
    else setApplyMsg({ tone: 'danger', text: `Could not apply the template (${res.errorCode ?? 'error'}).` });
  };

  return (
    <section className="scr" aria-label="Prescription templates">
      <div className="scr__card" data-testid="rx-template-form">
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Define a template</h3>
          <StatusTag tone={items.length > 0 ? 'success' : 'neutral'} icon={items.length > 0 ? 'check' : null}>{`${items.length} item(s)`}</StatusTag>
        </div>
        <p className="scr__kpi-meta">One item per line: medicineCode | substanceCode | dose | frequency. Applying a template proposes prescriptions for a prescriber to confirm; it never prescribes on its own.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Code" hint="Template code" data-testid="rx-template-code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Field label="Name" hint="What the protocol is for" data-testid="rx-template-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </div>
        <div style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Items" hint="One per line: medicineCode | substanceCode | dose | frequency" data-testid="rx-template-items" value={itemsText} onChange={(e) => setItemsText(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" icon={<Icon name="check" />} data-testid="rx-template-submit" disabled={defining}
            {...(code.trim() === '' ? { disabledReason: 'Enter the code' } : name.trim() === '' ? { disabledReason: 'Enter the name' } : items.length === 0 ? { disabledReason: 'Add at least one valid item line' } : {})}
            onClick={define}>Save template</Button>
        </div>
        {defMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={defMsg.tone} assertive={defMsg.tone === 'danger'}>{defMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="rx-apply-form">
        <h3 className="scr__section-title">Apply a template</h3>
        <div className="scr__toolbar" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Template code" hint="The template to apply" data-testid="rx-apply-code" value={applyCode} onChange={(e) => setApplyCode(e.currentTarget.value)} />
          <Button variant="secondary" icon={<Icon name="sync" />} data-testid="rx-apply-go" disabled={applying}
            {...(applyCode.trim() === '' ? { disabledReason: 'Enter a template code' } : {})} onClick={apply}>Propose</Button>
        </div>
        {applyMsg && <Banner tone="danger" assertive>{applyMsg.text}</Banner>}
        {proposals !== null && (
          proposals.length === 0
            ? <Banner tone="info">The template produced no proposals.</Banner>
            : (
              <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-2)' }}>
                <table className="scr__table" data-testid="rx-proposals">
                  <caption className="sancta-visually-hidden">Prescribing proposals produced by the template, for a prescriber to confirm</caption>
                  <thead><tr><th scope="col">Medicine</th><th scope="col">Dose</th><th scope="col">Frequency</th></tr></thead>
                  <tbody>{proposals.map((pr, i) => (<tr key={`${pr.medicineCode}-${i}`}><td>{pr.medicineCode}</td><td>{pr.dose ?? '—'}</td><td>{pr.frequency ?? '—'}</td></tr>))}</tbody>
                </table>
              </div>
            )
        )}
      </div>
    </section>
  );
}
