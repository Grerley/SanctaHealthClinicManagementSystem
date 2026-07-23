import type { ScreenDef } from './types.ts';
import { Devices } from '../screens/Devices.tsx';

/** Administration — device trust and (later) site/settings. */
export const screens: ScreenDef[] = [
  { id: 'devices', moduleId: 'admin', label: 'Devices', hint: 'Trust and revocation', render: () => <Devices /> },
];
