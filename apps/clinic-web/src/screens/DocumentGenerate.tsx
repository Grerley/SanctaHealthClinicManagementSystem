import { useState } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { type Patient } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const GENERATED_BY = 'demo-operator';

type Template = 'visit_summary' | 'prescription' | 'sick_note' | 'referral_letter';
type DocSection = { heading: string; lines: string[] };
type ClinicalDocument = { type: Template; title: string; patientRef: string; sections: DocSection[] };
type GenerateOut = { documentId: string; sha256: string };

const TEMPLATES: Array<{ value: Template; label: string; title: string }> = [
  { value: 'visit_summary', label: 'Visit summary', title: 'Visit summary' },
  { value: 'prescription', label: 'Prescription', title: 'Prescription' },
  { value: 'sick_note', label: 'Medical certificate', title: 'Medical certificate' },
  { value: 'referral_letter', label: 'Referral letter', title: 'Referral letter' },
];

/** DD/MM/YYYY for display inside the generated snapshot (NFR-020). */
function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

function patientLine(p: Patient): string {
  return `${p.given_name} ${p.family_name} (MRN ${p.mrn})`;
}

/**
 * Assemble the neutral structured ClinicalDocument the backend snapshots. Mirrors the
 * shape of @sancta/domain docgen (type + title + patientRef + sections) so the stored
 * snapshot is identical to a server-generated one.
 */
function buildDocument(template: Template, patient: Patient, f: Record<string, string>, today: string): ClinicalDocument {
  const t = TEMPLATES.find((x) => x.value === template)!;
  const base = { type: template, title: t.title, patientRef: patient.id };
  if (template === 'visit_summary') {
    const sections: DocSection[] = [
      { heading: 'Patient', lines: [patientLine(patient), `Visit date: ${ddmmyyyy(today)}`, `Seen by: ${f.clinician || '—'}`] },
    ];
    if (f.reason?.trim()) sections.push({ heading: 'Presenting complaint', lines: [f.reason.trim()] });
    if (f.plan?.trim()) sections.push({ heading: 'Plan', lines: [f.plan.trim()] });
    return { ...base, sections };
  }
  if (template === 'prescription') {
    const items = (f.items ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    return { ...base, sections: [
      { heading: 'Patient', lines: [patientLine(patient), `Date: ${ddmmyyyy(today)}`] },
      { heading: 'Prescribed items', lines: items.length ? items : ['—'] },
      { heading: 'Prescriber', lines: [f.prescriber || '—'] },
    ] };
  }
  if (template === 'sick_note') {
    return { ...base, sections: [
      { heading: 'Patient', lines: [patientLine(patient)] },
      { heading: 'Certified unfit for work', lines: [`From ${ddmmyyyy(f.from || today)} to ${ddmmyyyy(f.to || today)}`, `Reason: ${f.reason || '—'}`] },
      { heading: 'Certified by', lines: [f.clinician || '—'] },
    ] };
  }
  // referral_letter
  const sections: DocSection[] = [
    { heading: 'To', lines: [f.referTo || '—'] },
    { heading: 'Patient', lines: [patientLine(patient), `Date: ${ddmmyyyy(today)}`] },
    { heading: 'Reason for referral', lines: [f.reason || '—'] },
  ];
  if (f.findings?.trim()) sections.push({ heading: 'Relevant findings', lines: [f.findings.trim()] });
  sections.push({ heading: 'Referred by', lines: [f.referrer || '—'] });
  return { ...base, sections };
}

/**
 * Generate a clinical document from a template (DOC-002). The structured document is
 * assembled from data on the device, then stored as an immutable, content-hashed
 * snapshot at the hub — storing is a confirmed-commit write (§9.2); the draft is kept
 * on any failure. An optional retention class + retain-until date can be applied at
 * generation so the disposal schedule is set from the outset. Uses POST
 * /api/documents/generate — matching path+method on the edge and the Worker.
 */
export function DocumentGenerate({ patient }: { patient: Patient | null }) {
  const today = new Date().toISOString().slice(0, 10);
  const [template, setTemplate] = useState<Template>('visit_summary');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [security, setSecurity] = useState<'normal' | 'sensitive' | 'restricted'>('normal');
  const [retentionClass, setRetentionClass] = useState('');
  const [retainUntil, setRetainUntil] = useState('');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const setField = (k: string) => (e: { currentTarget: { value: string } }) => setFields((s) => ({ ...s, [k]: e.currentTarget.value }));

  const retentionIncomplete = (retentionClass.trim() !== '') !== (retainUntil.trim() !== '');

  const generate = async () => {
    if (!patient || retentionIncomplete) return;
    setBusy(true); setMsg(null);
    const document = buildDocument(template, patient, fields, today);
    const res = await mutate<GenerateOut>(
      '/api/documents/generate',
      {
        patientId: patient.id, document, securityLabel: security, generatedBy: GENERATED_BY,
        ...(retentionClass.trim() && retainUntil.trim() ? { retentionClass: retentionClass.trim(), retainUntil: retainUntil.trim() } : {}),
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.documentId) {
      setMsg({ tone: 'success', text: `Generated and stored. Reference ···${res.data.documentId.slice(-8)} · content hash ···${res.data.sha256.slice(-12)}. The snapshot is immutable.` });
      setFields({}); setRetentionClass(''); setRetainUntil(''); setIdemKey(newIdempotencyKey());
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was generated — your entry is kept; retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not generate the document (${res.errorCode ?? 'error'}). Your entry is kept.` });
    }
  };

  if (!patient) {
    return (
      <section className="scr" aria-label="Generate document">
        <div className="scr__card">
          <h3 className="scr__section-title">Generate document (DOC-02)</h3>
          <StateBlock state="empty" title="No patient in context">Choose a patient from Patients to generate a document for them.</StateBlock>
        </div>
      </section>
    );
  }

  return (
    <section className="scr" aria-label="Generate document">
      <div className="scr__card" data-testid="gen-form">
        <h3 className="scr__section-title">Generate document (DOC-02)</h3>
        <p className="scr__kpi-meta">
          Generating for {patient.given_name} {patient.family_name}. The document is assembled here and stored as an immutable, content-hashed snapshot at the hub.
        </p>

        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <label className="sancta-field">
            <span className="sancta-field__label">Template</span>
            <select className="sancta-field-input" data-testid="gen-template" value={template} onChange={(e) => { setTemplate(e.currentTarget.value as Template); setFields({}); }}>
              {TEMPLATES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="sancta-field">
            <span className="sancta-field__label">Security label</span>
            <select className="sancta-field-input" data-testid="gen-security" value={security} onChange={(e) => setSecurity(e.currentTarget.value as 'normal' | 'sensitive' | 'restricted')}>
              <option value="normal">Normal</option><option value="sensitive">Sensitive</option><option value="restricted">Restricted</option>
            </select>
          </label>
        </div>

        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
          {template === 'visit_summary' && <>
            <Field label="Seen by" hint="Clinician name" data-testid="gen-clinician" value={fields.clinician ?? ''} onChange={setField('clinician')} />
            <Field label="Presenting complaint" optional data-testid="gen-reason" value={fields.reason ?? ''} onChange={setField('reason')} />
            <Field label="Plan" optional data-testid="gen-plan" value={fields.plan ?? ''} onChange={setField('plan')} />
          </>}
          {template === 'prescription' && <>
            <Field label="Prescriber" data-testid="gen-prescriber" value={fields.prescriber ?? ''} onChange={setField('prescriber')} />
            <label className="sancta-field" style={{ gridColumn: '1 / -1' }}>
              <span className="sancta-field__label">Prescribed items</span>
              <span className="sancta-field__hint">One per line, e.g. Amoxicillin — 500 mg, three times daily, for 7 days</span>
              <textarea className="sancta-field-input scr__textarea" data-testid="gen-items" value={fields.items ?? ''} onChange={setField('items')} rows={4} />
            </label>
          </>}
          {template === 'sick_note' && <>
            <Field label="Unfit from" type="date" data-testid="gen-from" value={fields.from ?? ''} onChange={setField('from')} />
            <Field label="Unfit to" type="date" data-testid="gen-to" value={fields.to ?? ''} onChange={setField('to')} />
            <Field label="Reason" data-testid="gen-sick-reason" value={fields.reason ?? ''} onChange={setField('reason')} />
            <Field label="Certified by" data-testid="gen-sick-clinician" value={fields.clinician ?? ''} onChange={setField('clinician')} />
          </>}
          {template === 'referral_letter' && <>
            <Field label="Refer to" hint="Destination facility or clinician" data-testid="gen-referto" value={fields.referTo ?? ''} onChange={setField('referTo')} />
            <Field label="Referred by" data-testid="gen-referrer" value={fields.referrer ?? ''} onChange={setField('referrer')} />
            <Field label="Reason for referral" data-testid="gen-referral-reason" value={fields.reason ?? ''} onChange={setField('reason')} />
            <Field label="Relevant findings" optional data-testid="gen-findings" value={fields.findings ?? ''} onChange={setField('findings')} />
          </>}
        </div>

        <h3 className="scr__section-title" style={{ marginTop: 'var(--sancta-space-4)' }}>Retention (optional)</h3>
        <p className="scr__kpi-meta">Set both to schedule disposal from the outset, or leave blank to set retention later.</p>
        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-2)' }}>
          <Field label="Retention class" optional hint="e.g. clinical-10y" data-testid="gen-retention-class" value={retentionClass} onChange={(e) => setRetentionClass(e.currentTarget.value)} />
          <Field label="Retain until" optional type="date" data-testid="gen-retain-until" value={retainUntil} onChange={(e) => setRetainUntil(e.currentTarget.value)} />
        </div>

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="gen-submit" disabled={busy}
            {...(retentionIncomplete ? { disabledReason: 'Set both retention class and retain-until, or clear both' } : {})}
            onClick={generate}>Generate &amp; store</Button>
          <StatusTag tone="neutral" icon="lock">Immutable snapshot</StatusTag>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>
    </section>
  );
}
