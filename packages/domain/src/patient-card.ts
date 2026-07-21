/**
 * Patient card / QR payloads (PAT-006, pack §4.4). A scannable code on a patient
 * card must resolve to the record WITHOUT carrying any identifying data — if the
 * card is lost or photographed, the code alone reveals nothing. The QR therefore
 * encodes only an opaque reference to the internal id; the human-readable name is
 * printed for staff on the card face but never encoded in the machine-readable
 * token. Building the payload here (from the id alone) makes it structurally
 * impossible to leak PHI into the code.
 */

const CARD_PREFIX = 'SANCTA:PT:';

/** Opaque, PHI-free QR/scan payload for a patient card (PAT-006). */
export function patientCardQr(patientId: string): string {
  return CARD_PREFIX + patientId;
}

/** Resolve a scanned card payload back to the patient id, or null if not ours. */
export function resolvePatientCardQr(payload: string): string | null {
  if (!payload.startsWith(CARD_PREFIX)) return null;
  const id = payload.slice(CARD_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}
