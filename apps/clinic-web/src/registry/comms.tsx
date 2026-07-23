import type { ScreenDef } from './types.ts';
import { Comms } from '../screens/Comms.tsx';

/** Communications desk. */
export const screens: ScreenDef[] = [
  { id: 'comms', moduleId: 'comms', label: 'Comms', hint: 'Messages and replies', render: () => <Comms /> },
];
