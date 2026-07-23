import type { ScreenDef } from './types.ts';
import { Dashboard } from '../screens/Dashboard.tsx';

/** Management — command centre and (later) reports. */
export const screens: ScreenDef[] = [
  { id: 'dashboard', moduleId: 'management', label: 'Command centre', hint: 'Management', render: () => <Dashboard /> },
];
