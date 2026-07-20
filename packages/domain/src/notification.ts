/**
 * Safe appointment notifications (APT-009, NFR-018, pack §4.4). Reminders sent
 * over unprotected channels (SMS) must never reveal a sensitive appointment
 * reason — e.g. a specialty clinic that would disclose a condition. The reminder
 * always carries the logistics (date, time, place) but includes the reason ONLY
 * when the appointment is not marked sensitive. British English + DD/MM/YYYY.
 */
import { formatDateDDMMYYYY } from './locale.ts';

export type AppointmentInfo = {
  when: string; // ISO date
  time?: string; // HH:MM
  location?: string;
  reason?: string;
  sensitive: boolean;
};

/** Build an appointment reminder safe for an unprotected channel (APT-009). */
export function appointmentReminder(info: AppointmentInfo): string {
  const parts = [`Reminder: you have an appointment on ${formatDateDDMMYYYY(info.when)}${info.time ? ` at ${info.time}` : ''}.`];
  if (info.location) parts.push(`Location: ${info.location}.`);
  // The reason is included ONLY when not sensitive — never over an open channel.
  if (info.reason && !info.sensitive) parts.push(`Reason: ${info.reason}.`);
  parts.push('Please contact the clinic to reschedule if needed.');
  return parts.join(' ');
}

/** True if `message` discloses the given sensitive reason (used to assert it never does). */
export function disclosesReason(message: string, reason: string | undefined): boolean {
  if (!reason) return false;
  return message.toLowerCase().includes(reason.toLowerCase());
}
