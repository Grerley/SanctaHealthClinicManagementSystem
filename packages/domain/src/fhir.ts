/**
 * FHIR-compatible read mapping (SYN-009, pack §15.4). A thin, dependency-free
 * projection of internal records onto FHIR R4 resource shapes so external systems
 * can consume standard resources. This is the read/interoperability layer over the
 * versioned REST API; it never becomes the system of record.
 */

export type InternalPatient = {
  id: string;
  mrn: string | null;
  givenName: string | null;
  familyName: string | null;
  sex: string | null; // F | M | O | unknown
  dateOfBirth: string | null; // YYYY-MM-DD
  phone: string | null;
  deceased: boolean;
  deceasedAt: string | null; // YYYY-MM-DD
};

export type FhirPatient = {
  resourceType: 'Patient';
  id: string;
  identifier?: Array<{ system: string; value: string }>;
  name?: Array<{ use: 'official'; family?: string; given?: string[] }>;
  gender?: 'male' | 'female' | 'other' | 'unknown';
  birthDate?: string;
  deceasedDateTime?: string;
  deceasedBoolean?: boolean;
  telecom?: Array<{ system: 'phone'; value: string }>;
};

const MRN_SYSTEM = 'urn:sancta:mrn';

function gender(sex: string | null): 'male' | 'female' | 'other' | 'unknown' {
  switch ((sex ?? '').toUpperCase()) {
    case 'F':
    case 'FEMALE':
      return 'female';
    case 'M':
    case 'MALE':
      return 'male';
    case '':
      return 'unknown';
    default:
      return 'other';
  }
}

/** Map an internal patient to a FHIR R4 Patient resource. */
export function toFhirPatient(p: InternalPatient): FhirPatient {
  const out: FhirPatient = { resourceType: 'Patient', id: p.id };
  if (p.mrn) out.identifier = [{ system: MRN_SYSTEM, value: p.mrn }];
  if (p.familyName || p.givenName) out.name = [{ use: 'official', ...(p.familyName ? { family: p.familyName } : {}), ...(p.givenName ? { given: [p.givenName] } : {}) }];
  out.gender = gender(p.sex);
  if (p.dateOfBirth) out.birthDate = p.dateOfBirth;
  if (p.deceased) {
    if (p.deceasedAt) out.deceasedDateTime = p.deceasedAt;
    else out.deceasedBoolean = true;
  }
  if (p.phone) out.telecom = [{ system: 'phone', value: p.phone }];
  return out;
}

/** Wrap resources in a FHIR searchset Bundle. */
export function toFhirBundle(resources: readonly object[]): { resourceType: 'Bundle'; type: 'searchset'; total: number; entry: Array<{ resource: object }> } {
  return { resourceType: 'Bundle', type: 'searchset', total: resources.length, entry: resources.map((r) => ({ resource: r })) };
}

/** Minimal CapabilityStatement declaring the read-only FHIR surface (SYN-009). */
export function capabilityStatement(version: string): object {
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['json'],
    software: { name: 'Sancta Clinic Edge', version },
    rest: [{ mode: 'server', resource: [{ type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }] }] }],
  };
}
