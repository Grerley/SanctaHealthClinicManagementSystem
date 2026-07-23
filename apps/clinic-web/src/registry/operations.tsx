import type { ScreenDef } from './types.ts';
import { OpsTaskBoard } from '../screens/OpsTaskBoard.tsx';
import { OpsStaff } from '../screens/OpsStaff.tsx';
import { OpsProductivity } from '../screens/OpsProductivity.tsx';
import { OpsKpiTargets } from '../screens/OpsKpiTargets.tsx';
import { OpsKpiSnapshot } from '../screens/OpsKpiSnapshot.tsx';

/** Workforce, tasks and KPI operations workspace. */
export const screens: ScreenDef[] = [
  { id: 'ops-tasks', moduleId: 'operations', label: 'Task board', hint: 'Overdue operational tasks', render: () => <OpsTaskBoard /> },
  { id: 'ops-staff', moduleId: 'operations', label: 'Staff & credentials', hint: 'Add staff and check credentials', render: () => <OpsStaff /> },
  { id: 'ops-productivity', moduleId: 'operations', label: 'Productivity', hint: 'Staff activity over a period', render: () => <OpsProductivity /> },
  { id: 'ops-kpi-targets', moduleId: 'operations', label: 'KPI targets', hint: 'Actual vs target comparison', render: () => <OpsKpiTargets /> },
  { id: 'ops-kpi-snapshot', moduleId: 'operations', label: 'KPI snapshot', hint: 'Capture a period snapshot', render: () => <OpsKpiSnapshot /> },
];
