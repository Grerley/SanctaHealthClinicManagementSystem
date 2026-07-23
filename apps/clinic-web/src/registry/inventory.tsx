import type { ScreenDef } from './types.ts';
import { Inventory } from '../screens/Inventory.tsx';

/** Stock and expiry. */
export const screens: ScreenDef[] = [
  { id: 'inventory', moduleId: 'inventory', label: 'Inventory', hint: 'Stock and expiry', render: () => <Inventory /> },
];
