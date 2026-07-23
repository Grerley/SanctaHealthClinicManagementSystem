import type { ScreenDef } from './types.ts';
import { PayerRegistry } from '../screens/PayerRegistry.tsx';
import { PayerCoverage } from '../screens/PayerCoverage.tsx';
import { PayerClaims } from '../screens/PayerClaims.tsx';
import { PayerPreauth } from '../screens/PayerPreauth.tsx';

/** Payer / insurance / claims workspace (BIL-011). */
export const screens: ScreenDef[] = [
  { id: 'payer-registry', moduleId: 'payer', label: 'Payers', hint: 'Register schemes and insurers', render: () => <PayerRegistry /> },
  { id: 'payer-coverage', moduleId: 'payer', label: 'Coverage & eligibility', hint: 'Record coverage and check eligibility', render: (ctx) => <PayerCoverage patient={ctx.patient} /> },
  { id: 'payer-claims', moduleId: 'payer', label: 'Claims', hint: 'Submit and adjudicate claims', render: () => <PayerClaims /> },
  { id: 'payer-preauth', moduleId: 'payer', label: 'Pre-authorisation', hint: 'Request and decide pre-auths', render: (ctx) => <PayerPreauth patient={ctx.patient} /> },
];
