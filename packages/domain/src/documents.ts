/**
 * Document upload validation (DOC-004). Enforces a file-type allow-list, a size
 * limit and a required content hash before a document may be stored; anything
 * failing the type/size checks is quarantined, not opened. This is a safety
 * control, so it lives in the trusted domain layer and is unit-tested.
 */

export type UploadPolicy = {
  allowedMime: readonly string[];
  maxSizeBytes: number;
};

export const DEFAULT_UPLOAD_POLICY: UploadPolicy = {
  allowedMime: ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'],
  maxSizeBytes: 20 * 1024 * 1024, // 20 MB
};

export type UploadMeta = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Lower-case hex SHA-256 of the content — required for integrity + dedup. */
  sha256: string;
};

export type UploadValidation =
  | { ok: true }
  | { ok: false; reason: 'type_not_allowed' | 'too_large' | 'missing_hash' | 'empty'; quarantine: boolean };

const SHA256_RE = /^[0-9a-f]{64}$/;

export function validateUpload(meta: UploadMeta, policy: UploadPolicy = DEFAULT_UPLOAD_POLICY): UploadValidation {
  if (!meta.sha256 || !SHA256_RE.test(meta.sha256)) {
    return { ok: false, reason: 'missing_hash', quarantine: true };
  }
  if (meta.sizeBytes <= 0) {
    return { ok: false, reason: 'empty', quarantine: true };
  }
  if (!policy.allowedMime.includes(meta.mimeType)) {
    // Disallowed type is quarantined and cannot be opened by users (DOC-004).
    return { ok: false, reason: 'type_not_allowed', quarantine: true };
  }
  if (meta.sizeBytes > policy.maxSizeBytes) {
    return { ok: false, reason: 'too_large', quarantine: false };
  }
  return { ok: true };
}
