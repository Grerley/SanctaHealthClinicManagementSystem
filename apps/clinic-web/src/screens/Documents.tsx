import { useState, type ChangeEvent } from 'react';
import { Banner, Button, Field, StatusTag, StateBlock } from '@sancta/ui';
import { api, type Patient, type DocSearchRow } from '../api.ts';
import { mutate, newIdempotencyKey } from '../mutation.ts';
import './screens.css';

const UPLOADED_BY = 'demo-operator';
const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'];
const MAX_BYTES = 20 * 1024 * 1024;

type SecurityLabel = 'normal' | 'sensitive' | 'restricted';
type Picked = { filename: string; mimeType: string; sizeBytes: number; sha256: string };
type UploadOut = { documentId: string; status: 'available' | 'quarantined'; reason?: string };

const QUARANTINE_TEXT: Record<string, string> = {
  type_not_allowed: 'File type is not allowed — only PDF, PNG, JPEG or TIFF may be stored.',
  too_large: 'File exceeds the 20 MB limit.',
  missing_hash: 'The file could not be hashed for integrity.',
  empty: 'The file is empty.',
};

/** Lower-case hex SHA-256 of the file contents, computed on the device (Web Crypto). */
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Document upload + register (DOC-01/004). The file is hashed on the device and its
 * type/size are validated against the trusted policy at the hub: anything outside
 * the allow-list (PDF/PNG/JPEG/TIFF, ≤20 MB) is QUARANTINED, not opened — an unsafe
 * or unexpected file can never silently enter the record. Registering is a
 * confirmed-commit write (§9.2). Search runs only on request, so the screen does no
 * load-time fetch. Uses /api/documents and /api/documents/search — matching paths on
 * both the edge and the Worker.
 */
export function Documents({ patient }: { patient: Patient | null }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [docType, setDocType] = useState('referral-letter');
  const [security, setSecurity] = useState<SecurityLabel>('normal');
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);

  const [term, setTerm] = useState('');
  const [results, setResults] = useState<DocSearchRow[] | null>(null);
  const [searching, setSearching] = useState(false);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    setMsg(null);
    if (!file) { setPicked(null); return; }
    try {
      const sha256 = await sha256Hex(await file.arrayBuffer());
      setPicked({ filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, sha256 });
      setIdemKey(newIdempotencyKey());
    } catch {
      setPicked(null);
      setMsg({ tone: 'danger', text: 'The file could not be read on this device.' });
    }
  };

  // Advisory client-side pre-check — the hub is authoritative.
  const clientWarn = picked && (!ALLOWED.includes(picked.mimeType) ? 'type' : picked.sizeBytes > MAX_BYTES ? 'size' : null);

  const register = async () => {
    if (!picked || !docType.trim()) return;
    setBusy(true); setMsg(null);
    const res = await mutate<UploadOut>(
      '/api/documents',
      {
        filename: picked.filename, mimeType: picked.mimeType, sizeBytes: picked.sizeBytes, sha256: picked.sha256,
        docType: docType.trim(), securityLabel: security, ...(patient ? { patientId: patient.id } : {}), uploadedBy: UPLOADED_BY,
      },
      { idempotencyKey: idemKey },
    );
    setBusy(false);
    if (res.ok && res.data?.status === 'available') {
      setMsg({ tone: 'success', text: `Stored and available. Document ···${res.data.documentId.slice(-8)}${patient ? ` on ${patient.given_name} ${patient.family_name}` : ''}.` });
      setPicked(null); setIdemKey(newIdempotencyKey());
    } else if (res.ok && res.data?.status === 'quarantined') {
      setMsg({ tone: 'danger', text: `Quarantined — ${QUARANTINE_TEXT[res.data.reason ?? ''] ?? 'the file failed validation'} It was NOT added to the record and cannot be opened.` });
    } else if (res.errorCode === 'network') {
      setMsg({ tone: 'danger', text: 'Could not reach the clinic hub. Nothing was stored — retry when connected.' });
    } else {
      setMsg({ tone: 'danger', text: `Could not register the document (${res.errorCode ?? 'error'}).` });
    }
  };

  const runSearch = async () => {
    if (!term.trim()) return;
    setSearching(true);
    try { const r = await api.searchDocuments(term.trim()); setResults(r.documents); }
    catch { setResults([]); setMsg({ tone: 'danger', text: 'Search is unavailable — the clinic hub may be unreachable.' }); }
    finally { setSearching(false); }
  };

  return (
    <section className="scr" aria-label="Documents">
      <div className="scr__card" data-testid="doc-upload">
        <h3 className="scr__section-title">Add a document (DOC-01)</h3>
        <p className="scr__kpi-meta">
          {patient ? `Attaching to ${patient.given_name} ${patient.family_name}. ` : 'No patient selected — the document will be unfiled. '}
          Allowed: PDF, PNG, JPEG, TIFF up to 20 MB. The file is hashed on this device; anything outside the policy is quarantined, not opened.
        </p>

        <div className="scr__form-grid" style={{ marginTop: 'var(--sancta-space-3)' }}>
          <label className="sancta-field">
            <span className="sancta-field__label">File</span>
            <span className="sancta-field__hint">Chosen on this device; contents never leave until you register</span>
            <input className="sancta-field-input" type="file" data-testid="doc-file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" onChange={onFile} />
          </label>
          <Field label="Document type" hint="e.g. referral-letter, lab-report, consent" data-testid="doc-type" value={docType} onChange={(e) => setDocType(e.currentTarget.value)} />
          <label className="sancta-field">
            <span className="sancta-field__label">Security label</span>
            <select className="sancta-field-input" data-testid="doc-security" value={security} onChange={(e) => setSecurity(e.currentTarget.value as SecurityLabel)}>
              <option value="normal">Normal</option><option value="sensitive">Sensitive</option><option value="restricted">Restricted</option>
            </select>
          </label>
        </div>

        {picked && (
          <div style={{ marginTop: 'var(--sancta-space-3)' }}>
            <div className="scr__kpi-meta" data-testid="doc-picked">
              {picked.filename} · {picked.mimeType} · {humanSize(picked.sizeBytes)} · sha256 ···{picked.sha256.slice(-12)}
            </div>
            {clientWarn && (
              <div style={{ marginTop: 'var(--sancta-space-2)' }}>
                <Banner tone="warning" title={clientWarn === 'type' ? 'This type is outside the allow-list' : 'This file is over 20 MB'}>
                  The clinic hub will quarantine it — choose a PDF, PNG, JPEG or TIFF within the size limit to store it.
                </Banner>
              </div>
            )}
          </div>
        )}

        <div className="scr__row" style={{ alignItems: 'center', marginTop: 'var(--sancta-space-3)' }}>
          <Button variant="primary" data-testid="doc-submit" disabled={busy}
            {...(!picked ? { disabledReason: 'Choose a file first' } : !docType.trim() ? { disabledReason: 'Enter a document type' } : {})}
            onClick={register}>Register document</Button>
        </div>
        {msg && <div style={{ marginTop: 'var(--sancta-space-3)' }}><Banner tone={msg.tone} assertive={msg.tone === 'danger'}>{msg.text}</Banner></div>}
      </div>

      <div className="scr__card" data-testid="doc-search">
        <h3 className="scr__section-title">Find a document</h3>
        <div className="scr__row" style={{ alignItems: 'flex-end' }}>
          <Field label="Search" hint="Filename or indexed term" data-testid="doc-term" value={term}
            onChange={(e) => setTerm(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} style={{ minWidth: 260 }} />
          <Button variant="secondary" data-testid="doc-search-btn" disabled={searching}
            {...(!term.trim() ? { disabledReason: 'Enter a search term' } : {})} onClick={runSearch}>Search</Button>
        </div>
        {results !== null && (
          results.length === 0
            ? <div style={{ marginTop: 'var(--sancta-space-3)' }}><StateBlock state="empty" title="No documents found" /></div>
            : (
              <div className="scr__table-scroll" style={{ marginTop: 'var(--sancta-space-3)' }}>
                <table className="scr__table" data-testid="doc-results">
                  <caption className="sancta-visually-hidden">Documents matching the search term</caption>
                  <thead><tr><th scope="col">Reference</th><th scope="col">Filename</th><th scope="col" style={{ textAlign: 'right' }}>Version</th></tr></thead>
                  <tbody>
                    {results.map((d) => (
                      <tr key={d.documentId}>
                        <td data-numeric>···{d.documentId.slice(-8)}</td>
                        <td>{d.filename}</td>
                        <td data-numeric style={{ textAlign: 'right' }}><StatusTag tone="neutral">{`v${d.version}`}</StatusTag></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
    </section>
  );
}
