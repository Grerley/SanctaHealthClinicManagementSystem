import type { ScreenDef } from './types.ts';
import { Devices } from '../screens/Devices.tsx';
import { InstanceMode } from '../screens/InstanceMode.tsx';
import { SystemHealth } from '../screens/SystemHealth.tsx';
import { AdminSettings } from '../screens/AdminSettings.tsx';
import { AuditLog } from '../screens/AuditLog.tsx';
import { SiteRegistry } from '../screens/SiteRegistry.tsx';

/** Administration — device trust, instance identity, platform health, feature config, audit and sites. */
export const screens: ScreenDef[] = [
  { id: 'devices', moduleId: 'admin', label: 'Devices', hint: 'Trust and revocation', render: () => <Devices /> },
  { id: 'instance-mode', moduleId: 'admin', label: 'Instance', hint: 'Environment identity (ADM-07)', render: () => <InstanceMode /> },
  { id: 'system-health', moduleId: 'admin', label: 'Health', hint: 'Platform health signals (ADM-05)', render: () => <SystemHealth /> },
  { id: 'admin-settings', moduleId: 'admin', label: 'Feature config', hint: 'Flags and published config (ADM-03/06)', render: () => <AdminSettings /> },
  { id: 'audit-log', moduleId: 'admin', label: 'Audit log', hint: 'Audit trail viewer and export (ADM-04)', render: () => <AuditLog /> },
  { id: 'site-registry', moduleId: 'admin', label: 'Sites', hint: 'Multi-site registry (OPS-08)', render: () => <SiteRegistry /> },
];
