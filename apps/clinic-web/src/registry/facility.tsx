import type { ScreenDef } from './types.ts';
import { FacilityResources } from '../screens/FacilityResources.tsx';
import { FacilityIncidents } from '../screens/FacilityIncidents.tsx';
import { FacilityMaintenance } from '../screens/FacilityMaintenance.tsx';
import { FacilityChecklists } from '../screens/FacilityChecklists.tsx';
import { FacilityCapacity } from '../screens/FacilityCapacity.tsx';

/** Facilities and estates management (OPS-002/004/005/006). */
export const screens: ScreenDef[] = [
  { id: 'facility-resources', moduleId: 'facility', label: 'Resources', hint: 'Rooms and equipment status', render: () => <FacilityResources /> },
  { id: 'facility-incidents', moduleId: 'facility', label: 'Incidents', hint: 'Raise and resolve incidents', render: () => <FacilityIncidents /> },
  { id: 'facility-maintenance', moduleId: 'facility', label: 'Maintenance', hint: 'Schedule and complete due work', render: () => <FacilityMaintenance /> },
  { id: 'facility-checklists', moduleId: 'facility', label: 'Checklists', hint: 'Define and run safety checklists', render: () => <FacilityChecklists /> },
  { id: 'facility-capacity', moduleId: 'facility', label: 'Capacity', hint: 'Available capacity and occupancy', render: () => <FacilityCapacity /> },
];
