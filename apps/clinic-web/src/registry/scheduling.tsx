import type { ScreenDef } from './types.ts';
import { Queue } from '../screens/Queue.tsx';
import { Calendar } from '../screens/Calendar.tsx';

/** Reception flow and appointments. */
export const screens: ScreenDef[] = [
  { id: 'queue', moduleId: 'scheduling', label: 'Queue', hint: 'Reception and flow', render: () => <Queue /> },
  { id: 'calendar', moduleId: 'scheduling', label: 'Calendar', hint: 'Appointments', render: () => <Calendar /> },
];
