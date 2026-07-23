import type { ScreenDef } from './types.ts';
import { Queue } from '../screens/Queue.tsx';
import { Calendar } from '../screens/Calendar.tsx';
import { BookAppointment } from '../screens/BookAppointment.tsx';
import { Waitlist } from '../screens/Waitlist.tsx';
import { VisitBoard } from '../screens/VisitBoard.tsx';
import { TriageQueue } from '../screens/TriageQueue.tsx';
import { TriageIntake } from '../screens/TriageIntake.tsx';

/** Reception flow and appointments. */
export const screens: ScreenDef[] = [
  { id: 'queue', moduleId: 'scheduling', label: 'Queue', hint: 'Reception and flow', render: () => <Queue /> },
  { id: 'calendar', moduleId: 'scheduling', label: 'Calendar', hint: 'Appointments', render: () => <Calendar /> },
  { id: 'book', moduleId: 'scheduling', label: 'Book', hint: 'Book slots, no-show, cancel', render: (ctx) => <BookAppointment patient={ctx.patient} /> },
  { id: 'waitlist', moduleId: 'scheduling', label: 'Waitlist', hint: 'Waiting list and slot fill', render: (ctx) => <Waitlist patient={ctx.patient} /> },
  { id: 'visit-board', moduleId: 'scheduling', label: 'Visit board', hint: 'Flow, transfer, complete', render: () => <VisitBoard /> },
  { id: 'triage-queue', moduleId: 'scheduling', label: 'Triage queue', hint: 'Sign off and hand off', render: () => <TriageQueue /> },
  { id: 'triage-intake', moduleId: 'scheduling', label: 'Triage intake', hint: 'Vitals and assessment', render: (ctx) => <TriageIntake patient={ctx.patient} /> },
];
