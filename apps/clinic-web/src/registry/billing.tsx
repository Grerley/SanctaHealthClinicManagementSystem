import type { ScreenDef } from './types.ts';
import { Cashier } from '../screens/Cashier.tsx';
import { Finance } from '../screens/Finance.tsx';

/** Cashier operations and the finance ledger. */
export const screens: ScreenDef[] = [
  { id: 'cashier', moduleId: 'billing', label: 'Cashier', hint: 'Shift close and drawer', render: () => <Cashier /> },
  { id: 'finance', moduleId: 'billing', label: 'Finance', hint: 'Debtors and ledger', render: () => <Finance /> },
];
