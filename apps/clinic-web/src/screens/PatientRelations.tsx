import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { jsonFetch, type Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

/**
 * Patient relationships (PAT-005) — guardians, emergency contacts and household
 * links for the patient in context. The list is a patient-scoped read (filtered by
 * a uuid patient_id), so it only fetches when a patient is selected. Adding a
 * related person is a confirmed-commit write (§9.2): success only on res.ok, the
 * draft is preserved on failure, and a fresh idempotency key is minted per intent.
 * Both the list and the add endpoint exist on the worker and edge backends.
 */
type RelatedPerson = { id: string; name: string; relationship: string; isGuardian: boolean; isEmergencyContact: boolean; phone: string | null };

const RELATIONSHIPS = ['mother', 'father', 'guardian', 'spouse', 'child', 'sibling', 'other'] as const;
type Relationship = (typeof RELATIONSHIPS)[number];

export function PatientRelations({ patient }: { patient: Patient | null }) {
  const [related, setRelated] = useState<RelatedPerson[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState<Relationship>('guardian');
  const [phone, setPhone] = useState('');
  const [isGuardian, setIsGuardian] = useState(true);
  const [isEmergency, setIsEmergency] = useState(false);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async (patientId: string) => {
    const r = await jsonFetch<{ related: RelatedPerson[] }>(`/api/patients/related?patientId=${encodeURIComponent(patientId)}`);
    setRelated(r.related);
  }, []);

  useEffect(() => {
    if (!patient) { setState('ready'); return; }
    setState('loading');
    void (async () => { try { await load(patient.id); setState('ready'); } catch { setState('error'); } })();
  }, [patient, load]);

  const canSubmit = patient !== null && name.trim().length > 0;

  const submit = async () => {
    if (!patient || !canSubmit) return;
    setBusy(true); setMsg(null);
    const res = await mutate<{ id: string }>(
      '/api/patients/related',
      {
        patientId: patient.id,
        name: name.trim(),
        relationship,
        isGuardian,
        isEmergencyContact: isEmergency,
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.id) {
      setMsg({ tone: 'success', text: `${name.trim()} added as ${relationship}.` });
      setName(''); setPhone(''); setIsGuardian(false); setIsEmergency(false); setIdemKey(newIdempotencyKey());
      try { await load(patient.id); } catch { /* connectivity indicator covers this */ }
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was saved — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not add the related person (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  if (!patient) {
    return <StateBlock state="permission-limited" title="No patient in context">Select a patient from the Patients screen to manage their relationships.</StateBlock>;
  }
  if (state === 'loading') return <StateBlock state="initial-loading" title="Loading relationships" />;
  if (state === 'error') return <StateBlock state="stale" title="Relationships unavailable">The clinic hub may be unreachable.</StateBlock>;

  return (
    <section className="scr" aria-label={`Relationships for ${patient.given_name} ${patient.family_name}`}>
      <div className="scr__card" data-testid="relations-form">
        <h3 className="scr__section-title">Add related person (PAT-005)</h3>
        <p className="scr__kpi-meta">Guardian, emergency contact or household member for {patient.given_name} {patient.family_name}.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Name" hint="Full name of the related person" data-testid="relations-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <div className="sancta-field">
            <label className="sancta-field__label" htmlFor="relations-relationship">Relationship</label>
            <div className="sancta-field__control">
              <select id="relations-relationship" className="sancta-field-input sancta-focusable" data-testid="relations-relationship" value={relationship} onChange={(e) => setRelationship(e.currentTarget.value as Relationship)}>
                {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <Field label="Phone" optional hint="Contact number" data-testid="relations-phone" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
        </div>
        <div className="scr__row" style={{ alignItems: 'center', gap: 'var(--sancta-space-4)', marginTop: 'var(--sancta-space-3)' }}>
          <label style={{ display: 'flex', gap: 'var(--sancta-space-2)', alignItems: 'center' }}>
            <input type="checkbox" data-testid="relations-guardian" checked={isGuardian} onChange={(e) => setIsGuardian(e.currentTarget.checked)} /> Guardian
          </label>
          <label style={{ display: 'flex', gap: 'var(--sancta-space-2)', alignItems: 'center' }}>
            <input type="checkbox" data-testid="relations-emergency" checked={isEmergency} onChange={(e) => setIsEmergency(e.currentTarget.checked)} /> Emergency contact
          </label>
        </div>
        <div className="scr__row" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="relations-submit" disabled={busy}
            {...(name.trim() === '' ? { disabledReason: 'Enter the person’s name first' } : {})}
            onClick={submit}>Add related person</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      <div>
        <div className="scr__toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 className="scr__section-title">Related persons</h3>
          <StatusTag tone={related.length > 0 ? 'neutral' : 'warning'} icon={related.length > 0 ? null : 'alert'}>
            {related.length > 0 ? `${related.length} on file` : 'None recorded'}
          </StatusTag>
        </div>
        {related.length === 0
          ? <StateBlock state="empty" title="No related persons recorded">Add a guardian or emergency contact above.</StateBlock>
          : (
            <div className="scr__table-scroll">
              <table className="scr__table" data-testid="relations-list">
                <caption className="sancta-visually-hidden">Related persons on file for this patient</caption>
                <thead>
                  <tr><th scope="col">Name</th><th scope="col">Relationship</th><th scope="col">Roles</th><th scope="col">Phone</th></tr>
                </thead>
                <tbody>
                  {related.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td>{r.relationship}</td>
                      <td style={{ display: 'flex', gap: 'var(--sancta-space-2)', flexWrap: 'wrap' }}>
                        {r.isGuardian ? <StatusTag tone="info" icon="lock">Guardian</StatusTag> : null}
                        {r.isEmergencyContact ? <StatusTag tone="warning" icon="alert">Emergency</StatusTag> : null}
                        {!r.isGuardian && !r.isEmergencyContact ? <StatusTag tone="neutral">Contact</StatusTag> : null}
                      </td>
                      <td>{r.phone ?? '—'}</td>
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
