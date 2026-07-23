import type { ModuleDef, ScreenDef } from './types.ts';
import { screens as today } from './today.tsx';
import { screens as patients } from './patients.tsx';
import { screens as clinical } from './clinical.tsx';
import { screens as scheduling } from './scheduling.tsx';
import { screens as inventory } from './inventory.tsx';
import { screens as billing } from './billing.tsx';
import { screens as comms } from './comms.tsx';
import { screens as selfservice } from './selfservice.tsx';
import { screens as payer } from './payer.tsx';
import { screens as records } from './records.tsx';
import { screens as facility } from './facility.tsx';
import { screens as operations } from './operations.tsx';
import { screens as admin } from './admin.tsx';
import { screens as management } from './management.tsx';

export type { ScreenDef, ModuleDef, ScreenCtx } from './types.ts';

/**
 * Role-ordered navigation modules (spec §4.1). Order here is the order they appear in
 * the nav. Adding a module is one line here plus its own registry file — nothing else.
 */
export const MODULES: ModuleDef[] = [
  { id: 'today', label: 'Today' },
  { id: 'patients', label: 'Patients' },
  { id: 'clinical', label: 'Clinical' },
  { id: 'scheduling', label: 'Scheduling' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'billing', label: 'Billing' },
  { id: 'comms', label: 'Comms' },
  { id: 'selfservice', label: 'Self-service' },
  { id: 'payer', label: 'Payer' },
  { id: 'records', label: 'Records' },
  { id: 'facility', label: 'Facility' },
  { id: 'operations', label: 'Operations' },
  { id: 'admin', label: 'Administration' },
  { id: 'management', label: 'Management' },
];

/** Every registered screen, in module order. The single source of truth the shell
 * renders from — nav and work area both derive from this, so a screen is live the
 * moment it is registered. */
export const SCREENS: ScreenDef[] = [
  ...today, ...patients, ...clinical, ...scheduling, ...inventory, ...billing, ...comms,
  ...selfservice, ...payer, ...records, ...facility, ...operations, ...admin, ...management,
];

/** Screens belonging to a module, in registration order. */
export function screensOf(moduleId: string): ScreenDef[] {
  return SCREENS.filter((s) => s.moduleId === moduleId);
}
