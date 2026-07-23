import type { ScreenDef } from './types.ts';
import { SelfServiceBookingRequests } from '../screens/SelfServiceBookingRequests.tsx';
import { SelfServiceNewRequest } from '../screens/SelfServiceNewRequest.tsx';
import { SelfServiceTokens } from '../screens/SelfServiceTokens.tsx';
import { SelfServicePayIntent } from '../screens/SelfServicePayIntent.tsx';
import { SelfServiceSummary } from '../screens/SelfServiceSummary.tsx';

/** Patient self-service / online portal back-office (COM-006). */
export const screens: ScreenDef[] = [
  { id: 'selfservice-requests', moduleId: 'selfservice', label: 'Booking requests', hint: 'Confirm online requests', render: () => <SelfServiceBookingRequests /> },
  { id: 'selfservice-new-request', moduleId: 'selfservice', label: 'New booking request', hint: 'Record an online request', render: () => <SelfServiceNewRequest /> },
  { id: 'selfservice-tokens', moduleId: 'selfservice', label: 'Access tokens', hint: 'Issue and revoke portal tokens', render: () => <SelfServiceTokens /> },
  { id: 'selfservice-pay-intent', moduleId: 'selfservice', label: 'Online payment', hint: 'Record a self-service pay intent', render: () => <SelfServicePayIntent /> },
  { id: 'selfservice-summary', moduleId: 'selfservice', label: 'Self-service summary', hint: 'Portal balance and appointments', render: () => <SelfServiceSummary /> },
];
