import type { ScreenDef } from './types.ts';
import { Queue } from '../screens/Queue.tsx';
import { Calendar } from '../screens/Calendar.tsx';
import { BookAppointment } from '../screens/BookAppointment.tsx';
import { Waitlist } from '../screens/Waitlist.tsx';
import { VisitBoard } from '../screens/VisitBoard.tsx';
import { TriageQueue } from '../screens/TriageQueue.tsx';
import { TriageIntake } from '../screens/TriageIntake.tsx';
import { ScheduleTypes } from '../screens/ScheduleTypes.tsx';
import { ScheduleReminders } from '../screens/ScheduleReminders.tsx';
import { ScheduleNext } from '../screens/ScheduleNext.tsx';
import { VisitLifecycle } from '../screens/VisitLifecycle.tsx';

/** Reception flow and appointments. */
export const screens: ScreenDef[] = [
  { id: 'queue', moduleId: 'scheduling', label: 'Queue', hint: 'Reception and flow', render: () => <Queue /> },
  { id: 'calendar', moduleId: 'scheduling', label: 'Calendar', hint: 'Appointments', render: () => <Calendar /> },
  { id: 'book', moduleId: 'scheduling', label: 'Book', hint: 'Book slots, no-show, cancel', render: (ctx) => <BookAppointment patient={ctx.patient} /> },
  { id: 'waitlist', moduleId: 'scheduling', label: 'Waitlist', hint: 'Waiting list and slot fill', render: (ctx) => <Waitlist patient={ctx.patient} /> },
  { id: 'visit-board', moduleId: 'scheduling', label: 'Visit board', hint: 'Flow, transfer, complete', render: () => <VisitBoard /> },
  { id: 'triage-queue', moduleId: 'scheduling', label: 'Triage queue', hint: 'Sign off and hand off', render: () => <TriageQueue /> },
  { id: 'triage-intake', moduleId: 'scheduling', label: 'Triage intake', hint: 'Vitals and assessment', render: (ctx) => <TriageIntake patient={ctx.patient} /> },
  { id: 'appointment-types', moduleId: 'scheduling', label: 'Appt types', hint: 'Versioned service definitions', render: () => <ScheduleTypes /> },
  { id: 'reminders', moduleId: 'scheduling', label: 'Reminders', hint: 'Preview and enqueue reminders', render: () => <ScheduleReminders /> },
  { id: 'next-available', moduleId: 'scheduling', label: 'Next available', hint: 'Find the soonest slot', render: () => <ScheduleNext /> },
  { id: 'visit-lifecycle', moduleId: 'scheduling', label: 'Visit lifecycle', hint: 'Durations and transitions', render: () => <VisitLifecycle /> },
];
