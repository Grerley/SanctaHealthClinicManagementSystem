import type { ScreenDef } from './types.ts';
import { Patients } from '../screens/Patients.tsx';
import { Chart } from '../screens/Chart.tsx';
import { PatientDemographics } from '../screens/PatientDemographics.tsx';
import { PatientRelations } from '../screens/PatientRelations.tsx';
import { PatientMerge } from '../screens/PatientMerge.tsx';
import { PatientAccess } from '../screens/PatientAccess.tsx';

/** Patient administration — search/registration and the longitudinal chart. */
export const screens: ScreenDef[] = [
  { id: 'patients', moduleId: 'patients', label: 'Patients', hint: 'Search and registration', render: (ctx) => <Patients onSelect={ctx.setPatient} /> },
  { id: 'chart', moduleId: 'patients', label: 'Chart', hint: 'Clinical record', render: (ctx) => <Chart patient={ctx.patient} /> },
  { id: 'demographics', moduleId: 'patients', label: 'Demographics', hint: 'Identity view & freshness', render: (ctx) => <PatientDemographics patient={ctx.patient} /> },
  { id: 'relations', moduleId: 'patients', label: 'Relations', hint: 'Guardians & contacts', render: (ctx) => <PatientRelations patient={ctx.patient} /> },
  { id: 'merge', moduleId: 'patients', label: 'Merge', hint: 'Duplicate detection & merge', render: (ctx) => <PatientMerge patient={ctx.patient} /> },
  { id: 'access', moduleId: 'patients', label: 'Access', hint: 'Restricted-record break-glass', render: (ctx) => <PatientAccess patient={ctx.patient} /> },
];
