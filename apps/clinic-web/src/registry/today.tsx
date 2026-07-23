import type { ScreenDef } from './types.ts';
import { Dispense } from '../screens/Dispense.tsx';
import { Inbox } from '../screens/Inbox.tsx';

/** "Today" — the flagship dispense-and-pay slice and the critical-results inbox. */
export const screens: ScreenDef[] = [
  { id: 'dispense', moduleId: 'today', label: 'Dispense & Pay', hint: 'Pharmacy and cashier', render: () => <Dispense /> },
  { id: 'inbox', moduleId: 'today', label: 'Inbox', hint: 'Critical results & tasks', render: () => <Inbox /> },
];
