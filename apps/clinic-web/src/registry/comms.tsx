import type { ScreenDef } from './types.ts';
import { Comms } from '../screens/Comms.tsx';
import { CommsCompose } from '../screens/CommsCompose.tsx';
import { CommsConsent } from '../screens/CommsConsent.tsx';
import { CommsInbound } from '../screens/CommsInbound.tsx';

/** Communications desk. */
export const screens: ScreenDef[] = [
  { id: 'comms', moduleId: 'comms', label: 'Comms', hint: 'Messages and replies', render: () => <Comms /> },
  { id: 'comms-compose', moduleId: 'comms', label: 'Compose', hint: 'Queue an outbound message', render: (ctx) => <CommsCompose patient={ctx.patient} /> },
  { id: 'comms-consent', moduleId: 'comms', label: 'Consent', hint: 'Channel consent per patient', render: (ctx) => <CommsConsent patient={ctx.patient} /> },
  { id: 'comms-inbound', moduleId: 'comms', label: 'Log inbound', hint: 'Turn a reply into a task', render: (ctx) => <CommsInbound patient={ctx.patient} /> },
];
