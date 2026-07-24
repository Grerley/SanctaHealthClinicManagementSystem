/**
 * Personas (spec §5.1 role model). A clinic runs on one shared, device-bound install;
 * "signing in" here means declaring WHO is at the device this shift, which scopes the
 * navigation to that role's workflow and sets the RBAC roles sent to the hub. Personas
 * interlink through the shared patient context — e.g. Reception books a visit, the
 * Nurse triages it, the Clinician consults, the Cashier settles — without leaving the
 * shell. The Administrator carries every role for full access.
 *
 * Roles map to the backend permission matrix (packages/domain/src/rbac.ts). A persona's
 * `modules` are the nav groups it sees; `home` is where it lands after signing in.
 */
export type Persona = {
  id: string;
  label: string;
  blurb: string;
  accent: string;
  roles: string[];
  /** Module ids this persona works in, in nav order, or 'all' for the Administrator. */
  modules: string[] | 'all';
  home: string;
};

export const PERSONAS: Persona[] = [
  {
    id: 'reception', label: 'Reception', blurb: 'Register, search, book and check patients in.',
    accent: '#0B6BCB', roles: ['reception'],
    modules: ['today', 'patients', 'scheduling', 'selfservice', 'comms'], home: 'patients',
  },
  {
    id: 'nurse', label: 'Nurse', blurb: 'Triage, vitals, observations and the medication round.',
    accent: '#1E9E6A', roles: ['clinical', 'stock'],
    modules: ['today', 'patients', 'scheduling', 'clinical'], home: 'triage-queue',
  },
  {
    id: 'clinician', label: 'Clinician', blurb: 'Consult, prescribe, order tests and document care.',
    accent: '#5A4BD6', roles: ['clinical'],
    modules: ['today', 'patients', 'clinical', 'scheduling', 'records'], home: 'inbox',
  },
  {
    id: 'pharmacist', label: 'Pharmacist', blurb: 'Dispense, check the formulary and manage stock.',
    accent: '#B7791F', roles: ['clinical', 'stock'],
    modules: ['today', 'patients', 'clinical', 'inventory'], home: 'dispense',
  },
  {
    id: 'cashier', label: 'Cashier', blurb: 'Invoice, take payment, refund and reconcile the till.',
    accent: '#0E7490', roles: ['cashier'],
    modules: ['today', 'patients', 'billing', 'payer'], home: 'dispense',
  },
  {
    id: 'store', label: 'Store keeper', blurb: 'Receive goods, count stock and keep facilities.',
    accent: '#B45309', roles: ['stock'],
    modules: ['today', 'inventory', 'facility'], home: 'inventory',
  },
  {
    id: 'manager', label: 'Manager', blurb: 'Command centre, finance reporting and operations.',
    accent: '#B83280', roles: ['manager', 'finance', 'auditor', 'cashier'],
    modules: ['today', 'management', 'operations', 'billing', 'payer'], home: 'dashboard',
  },
  {
    id: 'administrator', label: 'Administrator', blurb: 'Full access across every module and setting.',
    accent: '#334155', roles: ['reception', 'clinical', 'cashier', 'stock', 'finance', 'manager', 'administrator', 'auditor'],
    modules: 'all', home: 'dispense',
  },
];

export function personaById(id: string | null): Persona | null {
  return id ? (PERSONAS.find((p) => p.id === id) ?? null) : null;
}

/** Per-module accent + short monogram for the nav badges (premium, icon-font-free). */
export const MODULE_ACCENT: Record<string, string> = {
  today: '#0B6BCB', patients: '#0E7490', clinical: '#5A4BD6', scheduling: '#1E9E6A',
  inventory: '#B45309', billing: '#B83280', comms: '#2563EB', selfservice: '#0891B2',
  payer: '#7C3AED', records: '#475569', facility: '#B7791F', operations: '#DB2777',
  admin: '#334155', management: '#0F766E',
};
