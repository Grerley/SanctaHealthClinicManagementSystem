import type { ScreenDef } from './types.ts';
import { Patients } from '../screens/Patients.tsx';
import { Chart } from '../screens/Chart.tsx';

/** Patient administration — search/registration and the longitudinal chart. */
export const screens: ScreenDef[] = [
  { id: 'patients', moduleId: 'patients', label: 'Patients', hint: 'Search and registration', render: (ctx) => <Patients onSelect={ctx.setPatient} /> },
  { id: 'chart', moduleId: 'patients', label: 'Chart', hint: 'Clinical record', render: (ctx) => <Chart patient={ctx.patient} /> },
];
