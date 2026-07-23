import { useState } from 'react';
import { Banner, Button, Field, Icon, StatusTag, StateBlock } from '@sancta/ui';
import { money } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

// Above this estimated value a requisition needs an authorised (approve-role) approver
// (SoD, BR-011). The server enforces this and segregation authoritatively.
const SOD_THRESHOLD_MINOR = 100_000; // $1,000.00

type Line = { sku: string; quantity: string };
type Raised = { id: string; reference: string; estValueMinor: number; status: 'submitted' | 'approved' | 'rejected' };

const STATUS_TONE: Record<Raised['status'], 'neutral' | 'success' | 'danger'> = { submitted: 'neutral', approved: 'success', rejected: 'danger' };

/**
 * Purchase requisitions — create and approve/decide (INV-003). Creating a requisition
 * captures the requested lines and an estimated value; the hub records the requester.
 * A DECISION is a segregated control event (BR-011): the approver must differ from
 * the requester, and above the value threshold must hold an approve role — the clinic
 * hub enforces both and rejects a decision that violates them. Both actions are
 * confirmed-commit writes (§9.2). There is no unscoped list endpoint, so decisions
 * act on requisitions raised in this session (or an id pasted in) — no GET on mount.
 */
export function Requisitions() {
  // --- Create draft ---------------------------------------------------------
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [estValue, setEstValue] = useState(''); // dollars
  const [lines, setLines] = useState<Line[]>([{ sku: '', quantity: '' }]);
  const [createIdem, setCreateIdem] = useState(newIdempotencyKey());
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  // Requisitions raised this session, so they can be decided without a list read.
  const [raised, setRaised] = useState<Raised[]>([]);

  // --- Decide draft ---------------------------------------------------------
  const [decideId, setDecideId] = useState('');
  const [decideIdem, setDecideIdem] = useState(newIdempotencyKey());
  const [deciding, setDeciding] = useState(false);
  const [decideMsg, setDecideMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const estValueMinor = Math.round((Number(estValue) || 0) * 100);
  const validLines = lines
    .map((l) => ({ sku: l.sku.trim(), quantity: Math.floor(Number(l.quantity)) }))
    .filter((l) => l.sku !== '' && Number.isFinite(l.quantity) && l.quantity > 0);
  const canCreate = reference.trim() !== '' && validLines.length > 0;
  const overThreshold = estValueMinor > SOD_THRESHOLD_MINOR;

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { sku: '', quantity: '' }]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));

  const create = async () => {
    if (!canCreate) return;
    setCreating(true); setCreateMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/procurement/requisition',
      {
        reference: reference.trim(),
        lines: validLines,
        estValueMinor,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      { idempotencyKey: createIdem },
    );
    setCreating(false);
    if (res.ok && res.data?.id) {
      setRaised((r) => [{ id: res.data!.id, reference: reference.trim(), estValueMinor, status: 'submitted' }, ...r]);
      setCreateMsg({ tone: 'success', text: `Requisition ${reference.trim()} submitted (${validLines.length} line${validLines.length === 1 ? '' : 's'}, est. ${money(estValueMinor)}). Reference ···${res.data.id.slice(-8)} — it is now awaiting a decision.` });
      setReference(''); setNote(''); setEstValue(''); setLines([{ sku: '', quantity: '' }]); setCreateIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setCreateMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was submitted — your draft is kept; retry when connected.' });
    } else {
      setCreateMsg({ tone: 'danger', text: `Could not submit the requisition (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Your draft is kept.` });
    }
  };

  const decide = async (approve: boolean) => {
    const id = decideId.trim();
    if (id === '') return;
    setDeciding(true); setDecideMsg(null);
    const res = await mutate<{ status: 'approved' | 'rejected' }>(
      '/api/procurement/requisition/decide',
      { requisitionId: id, approve },
      { idempotencyKey: decideIdem },
    );
    setDeciding(false);
    if (res.ok && res.data?.status) {
      const status = res.data.status;
      setRaised((r) => r.map((x) => (x.id === id ? { ...x, status } : x)));
      setDecideMsg({ tone: 'success', text: `Requisition ···${id.slice(-8)} ${status}. An approval audit event was recorded.` });
      setDecideId(''); setDecideIdem(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setDecideMsg({ tone: 'danger', text: 'Could not reach the clinic hub. No decision was recorded — retry when connected.' });
    } else {
      // Segregation (approver == requester), threshold, or state violations surface here.
      setDecideMsg({ tone: 'danger', text: `The hub rejected the decision (${res.errorCode ?? 'error'}${res.errorMessage ? `: ${res.errorMessage}` : ''}). Nothing was changed.` });
    }
  };

  return (
    <section className="scr" aria-label="Purchase requisitions">
      <div className="scr__card" data-testid="req-form">
        <h3 className="scr__section-title">Raise a requisition (INV-003)</h3>
        <p className="scr__kpi-meta">Capture the items requested and an estimated value. Above {money(SOD_THRESHOLD_MINOR)} the approval must come from an authorised approver, and the approver must always differ from the requester (BR-011).</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Reference" hint="Your requisition reference" data-testid="req-reference" value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
          <Field label="Estimated value" optional numeric min={0} step="0.01" prefix="$" hint="Drives the approval threshold" data-testid="req-est" value={estValue} onChange={(e) => setEstValue(e.currentTarget.value)} />
          <Field label="Note" optional hint="Context for the approver" data-testid="req-note" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        </div>

        <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <table className="scr__table" data-testid="req-lines">
            <caption className="sancta-visually-hidden">Requisition lines — the SKU and quantity requested</caption>
            <thead><tr><th scope="col">SKU</th><th scope="col" style={{ textAlign: 'right' }}>Quantity</th><th scope="col"></th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><Field label={`SKU for line ${i + 1}`} hideLabel data-testid={`req-line-sku-${i}`} value={l.sku} onChange={(e) => setLine(i, { sku: e.currentTarget.value })} /></td>
                  <td style={{ textAlign: 'right' }}><Field label={`Quantity for line ${i + 1}`} hideLabel numeric min={1} step={1} data-testid={`req-line-qty-${i}`} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.currentTarget.value })} style={{ maxWidth: 120, marginInlineStart: 'auto' }} /></td>
                  <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`req-line-remove-${i}`} {...(lines.length === 1 ? { disabledReason: 'A requisition needs at least one line' } : {})} onClick={() => removeLine(i)}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="secondary" icon={<Icon name="draft" />} data-testid="req-add-line" onClick={addLine}>Add line</Button>
          {overThreshold && <StatusTag tone="warning" icon="alert">{`Above ${money(SOD_THRESHOLD_MINOR)} — needs an authorised approver`}</StatusTag>}
          <Button variant="primary" icon={<Icon name="check" />} data-testid="req-submit" disabled={creating}
            {...(reference.trim() === '' ? { disabledReason: 'Enter a requisition reference' } : validLines.length === 0 ? { disabledReason: 'Add at least one line with a SKU and quantity' } : {})}
            onClick={create}>Submit requisition</Button>
        </div>
        {createMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={createMsg.tone} assertive={createMsg.tone === 'danger'}>{createMsg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="req-decide">
        <h3 className="scr__section-title">Decide a requisition (segregated)</h3>
        <p className="scr__kpi-meta">Approving or rejecting is a control event. The clinic hub records the decision only if the approver differs from the requester and — above threshold — holds an approve role; otherwise it rejects the decision and nothing changes.</p>
        <div className="scr__row" style={{ alignItems: 'flex-end', marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Requisition id" hint="Paste an id, or pick one raised below" data-testid="req-decide-id" value={decideId} onChange={(e) => setDecideId(e.currentTarget.value)} style={{ minWidth: 300 }} />
          <Button variant="primary" icon={<Icon name="check" />} data-testid="req-approve" disabled={deciding}
            {...(decideId.trim() === '' ? { disabledReason: 'Enter the requisition id to decide' } : {})}
            onClick={() => decide(true)}>Approve</Button>
          <Button variant="secondary" tone="danger" icon={<Icon name="alert" />} data-testid="req-reject" disabled={deciding}
            {...(decideId.trim() === '' ? { disabledReason: 'Enter the requisition id to decide' } : {})}
            onClick={() => decide(false)}>Reject</Button>
        </div>
        {decideMsg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={decideMsg.tone} assertive={decideMsg.tone === 'danger'}>{decideMsg.text}</Banner></div>}
      </div>

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Requisitions raised this session</h3>
          <StatusTag tone={raised.length > 0 ? 'neutral' : 'success'} icon={raised.length > 0 ? 'info' : 'check'}>
            {raised.length > 0 ? `${raised.length} raised` : 'None yet'}
          </StatusTag>
        </div>
        {raised.length === 0
          ? <StateBlock state="empty" title="No requisitions raised">Submit a requisition above to decide on it here.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="req-raised">
                <caption className="sancta-visually-hidden">Requisitions raised in this session and their decision status</caption>
                <thead><tr><th scope="col">Reference</th><th scope="col">Id</th><th scope="col" style={{ textAlign: 'right' }}>Est. value</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
                <tbody>
                  {raised.map((r) => (
                    <tr key={r.id} data-selected={decideId === r.id || undefined}>
                      <td>{r.reference}</td>
                      <td data-numeric>···{r.id.slice(-8)}</td>
                      <td data-numeric style={{ textAlign: 'right' }}>{money(r.estValueMinor)}</td>
                      <td><StatusTag tone={STATUS_TONE[r.status]} icon={r.status === 'submitted' ? null : r.status === 'approved' ? 'check' : 'alert'}>{r.status}</StatusTag></td>
                      <td style={{ textAlign: 'right' }}><Button variant="subtle" density="compact" data-testid={`req-pick-${r.id.slice(-8)}`} onClick={() => setDecideId(r.id)}>Decide</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </section>
  );
}
