import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type Patient, type EncounterNote, type EncounterAddendum } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

// In production the signer/author is the authenticated clinician; the demo
// operator holds the clinical role (create/amend/sign).
const CLINICIAN = 'demo-operator';

type Phase = 'idle' | 'draft' | 'signed';
type NoteField = keyof EncounterNote;
const NOTE_FIELDS: Array<{ key: NoteField; label: string; hint: string }> = [
  { key: 'subjective', label: 'Subjective', hint: 'Presenting complaint and history in the patient’s words' },
  { key: 'objective', label: 'Objective', hint: 'Examination findings, vitals, results reviewed' },
  { key: 'assessment', label: 'Assessment', hint: 'Clinical impression / working diagnosis' },
  { key: 'plan', label: 'Plan', hint: 'Management, prescriptions, follow-up, safety-netting' },
];

/**
 * Clinical encounter documentation & signing (EHR-03 / EHR-008/009, BR-003,
 * UAT-04). A note is drafted as SOAP, saved as a draft, then SIGNED — and a signed
 * note is IMMUTABLE: it can never be edited back, only corrected by a linked
 * addendum. Signing is the sharpest clinical write, so it is never optimistic
 * (§9.2): the clinician attests, the commit is confirmed by the hub before the note
 * shows signed, and the draft is preserved on any failure so nothing typed is lost.
 * The screen only opens with a patient in context (the identity strip stays visible).
 */
export function Encounter({ patient }: { patient: Patient | null }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [encounterId, setEncounterId] = useState<string | null>(null);
  const [note, setNote] = useState<EncounterNote>({});
  const [attest, setAttest] = useState(false);
  const [addenda, setAddenda] = useState<EncounterAddendum[]>([]);
  const [addText, setAddText] = useState('');
  const [signedBy, setSignedBy] = useState<string | null>(null);

  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  if (!patient) {
    return <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to document an encounter. Clinical writing always names the patient it belongs to.</StateBlock>;
  }

  const setField = (k: NoteField, v: string) => setNote((n) => ({ ...n, [k]: v }));
  const hasContent = NOTE_FIELDS.some((f) => (note[f.key] ?? '').trim().length > 0);

  const startEncounter = async () => {
    setBusy(true); setMsg(null);
    const res = await mutate<{ encounterId: string; visitId: string }>(
      '/api/encounters', { patientId: patient.id }, { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.encounterId) {
      setEncounterId(res.data.encounterId); setPhase('draft'); setNote({}); setAttest(false); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub to open an encounter. Nothing was created; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not open an encounter (${res.errorCode ?? 'error'}).` });
    }
  };

  const saveDraft = async () => {
    if (!encounterId) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ ok: true }>(
      '/api/encounters/draft', { encounterId, content: note }, { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false);
    if (res.ok) setMsg({ tone: 'success', text: 'Draft saved to the clinic. It stays editable until you sign.' });
    else if (res.errorCode === 'network') setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The draft was NOT saved — your text is kept; retry when connected.' });
    else setMsg({ tone: 'danger', text: `Could not save the draft (${res.errorCode ?? 'error'}). Your text is kept.` });
  };

  const sign = async () => {
    if (!encounterId || !hasContent || !attest) return;
    setBusy(true); setMsg(null);
    // Send the current content with the signature so nothing typed-but-unsaved is
    // lost at the moment of signing. Confirmed-commit only (never optimistic).
    const res = await mutate<{ status: 'signed' }>(
      '/api/encounters/sign', { encounterId, signedBy: CLINICIAN, content: note }, { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok) {
      setPhase('signed'); setSignedBy(CLINICIAN); setAddenda([]); setIdemKey(newIdempotencyKey());
      setMsg({ tone: 'success', text: 'Encounter signed and locked. It can no longer be edited — corrections must be added as an addendum.' });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The note was NOT signed — your draft is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not sign (${res.errorCode ?? 'error'}). Your draft is kept and stays editable.` });
    }
  };

  const addAddendum = async () => {
    if (!encounterId || !addText.trim()) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ addendumId: string }>(
      '/api/encounters/addendum', { encounterId, author: CLINICIAN, content: { text: addText.trim() } }, { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false);
    if (res.ok) {
      setAddText('');
      setMsg({ tone: 'success', text: 'Addendum added. The original signed note is unchanged.' });
      try { const d = await api.encounter(encounterId); setAddenda(d.addenda); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. The addendum was NOT added — your text is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not add the addendum (${res.errorCode ?? 'error'}). Your text is kept.` });
    }
  };

  const addendumText = (content: unknown): string =>
    typeof content === 'object' && content && 'text' in content ? String((content as { text: unknown }).text) : String(content);

  return (
    <section className="scr" aria-label="Encounter documentation">
      <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
        <h3 className="scr__section-title">Encounter note (EHR-03)</h3>
        <StatusTag
          tone={phase === 'signed' ? 'success' : phase === 'draft' ? 'warning' : 'neutral'}
          icon={phase === 'signed' ? 'lock' : phase === 'draft' ? 'draft' : null}
        >
          {phase === 'signed' ? 'Signed — immutable' : phase === 'draft' ? 'Draft — editable' : 'Not started'}
        </StatusTag>
      </div>

      {phase === 'idle' && (
        <div className="scr__card" data-testid="enc-start">
          <p className="scr__kpi-meta">Open a new encounter for {patient.given_name} {patient.family_name}. It starts as an editable draft; once you sign, the note is locked and any correction becomes a linked addendum.</p>
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="primary" data-testid="enc-start-btn" disabled={busy} onClick={startEncounter}>Start encounter</Button>
          </div>
        </div>
      )}

      {phase === 'draft' && (
        <div className="scr__card" data-testid="enc-draft">
          <div className="scr__form-grid">
            {NOTE_FIELDS.map((f) => (
              <label key={f.key} className="sancta-field">
                <span className="sancta-field__label">{f.label}</span>
                <span className="sancta-field__hint">{f.hint}</span>
                <textarea
                  className="sancta-field-input scr__textarea"
                  data-testid={`enc-${f.key}`}
                  rows={3}
                  value={note[f.key] ?? ''}
                  onChange={(e) => setField(f.key, e.currentTarget.value)}
                />
              </label>
            ))}
          </div>

          <label className="scr__attest" data-testid="enc-attest-wrap" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <input type="checkbox" data-testid="enc-attest" checked={attest} onChange={(e) => setAttest(e.currentTarget.checked)} />
            <span>I confirm this record is accurate and complete for signing. Once signed it cannot be edited.</span>
          </label>

          <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
            <Button variant="secondary" data-testid="enc-save-draft" disabled={busy} onClick={saveDraft}>Save draft</Button>
            <Button variant="primary" tone="danger" data-testid="enc-sign" disabled={busy}
              {...(!hasContent ? { disabledReason: 'Write the note before signing' } : !attest ? { disabledReason: 'Confirm the record is accurate before signing' } : {})}
              onClick={sign}>Sign &amp; lock</Button>
          </div>
          {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
        </div>
      )}

      {phase === 'signed' && (
        <div data-testid="enc-signed">
          <Banner tone="success" title="Signed clinical note — immutable">
            Signed by {signedBy}. This record is locked; corrections are added below as addenda and never overwrite it (BR-003).
          </Banner>
          <div className="scr__card" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <dl className="scr__note">
              {NOTE_FIELDS.map((f) => (
                <div key={f.key} className="scr__note-row">
                  <dt>{f.label}</dt>
                  <dd>{(note[f.key] ?? '').trim() || <span className="scr__kpi-meta">—</span>}</dd>
                </div>
              ))}
            </dl>
          </div>

          <h3 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-4)' }}>Addenda</h3>
          {addenda.length === 0
            ? <StateBlock state="empty" title="No addenda">Corrections or additions appear here, each attributed and timestamped.</StateBlock>
            : (
              <ul className="scr__addenda" data-testid="enc-addenda">
                {addenda.map((a, i) => (
                  <li key={i} className="scr__card">
                    <div className="scr__kpi-meta">{a.author} · {a.createdAt.slice(0, 16).replace('T', ' ')}</div>
                    <div>{addendumText(a.content)}</div>
                  </li>
                ))}
              </ul>
            )}

          <div className="scr__card" style={{ marginTop: 'var(--sancta-space-3)' }}>
            <div className="scr__row" style={{ alignItems: 'flex-end' }}>
              <Field label="Add an addendum" hint="A correction or addition; the signed note stays unchanged" data-testid="enc-addendum-text"
                value={addText} onChange={(e) => setAddText(e.currentTarget.value)} style={{ minWidth: 360 }} />
              <Button variant="secondary" data-testid="enc-addendum-submit" disabled={busy}
                {...(!addText.trim() ? { disabledReason: 'Write the addendum before adding it' } : {})}
                onClick={addAddendum}>Add addendum</Button>
            </div>
          </div>
          {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
        </div>
      )}
      {phase === 'idle' && msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive>{msg.text}</Banner></div>}
    </section>
  );
}
