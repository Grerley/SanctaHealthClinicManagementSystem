/**
 * Entity lifecycle state machines (pack §13.1) with guarded transitions.
 *
 * The safety-critical rule: signed clinical content is append-only — once an
 * encounter is `signed` it can only receive an addendum or be marked
 * entered-in-error; it is NEVER edited back to draft (EHR-008/009, BR-003).
 */

export class TransitionError extends Error {}

export type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(map: Transitions<S>, from: S, to: S): boolean {
  return (map[from] ?? []).includes(to);
}

export function assertTransition<S extends string>(map: Transitions<S>, from: S, to: S): S {
  if (!canTransition(map, from, to)) {
    throw new TransitionError(`illegal transition ${from} -> ${to}`);
  }
  return to;
}

// --- Encounter (Draft -> Ready to sign -> Signed; then addendum / entered-in-error)
export type EncounterState = 'draft' | 'ready_to_sign' | 'signed' | 'entered_in_error';
export const ENCOUNTER_TRANSITIONS: Transitions<EncounterState> = {
  draft: ['ready_to_sign', 'entered_in_error'],
  ready_to_sign: ['draft', 'signed', 'entered_in_error'],
  signed: ['entered_in_error'], // append-only: no path back to draft/edit
  entered_in_error: [],
};

export function isSignedImmutable(state: EncounterState): boolean {
  return state === 'signed' || state === 'entered_in_error';
}

// --- Invoice (Estimate -> Draft -> Finalised -> Part-paid -> Paid; alt: void, refunded)
export type InvoiceState =
  | 'estimate'
  | 'draft'
  | 'finalised'
  | 'part_paid'
  | 'paid'
  | 'voided'
  | 'refunded';
export const INVOICE_TRANSITIONS: Transitions<InvoiceState> = {
  estimate: ['draft', 'voided'],
  draft: ['finalised', 'voided'],
  finalised: ['part_paid', 'paid', 'voided'],
  part_paid: ['part_paid', 'paid', 'voided'],
  paid: ['refunded'],
  voided: [],
  refunded: [],
};

// --- Appointment (pack §13.1)
export type AppointmentState =
  | 'requested'
  | 'booked'
  | 'confirmed'
  | 'arrived'
  | 'checked_in'
  | 'in_service'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'left_before_seen';
export const APPOINTMENT_TRANSITIONS: Transitions<AppointmentState> = {
  requested: ['booked', 'cancelled'],
  booked: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['arrived', 'cancelled', 'no_show'],
  arrived: ['checked_in', 'left_before_seen'],
  checked_in: ['in_service', 'left_before_seen'],
  in_service: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
  left_before_seen: [],
};

// --- Visit (pack §13.1)
export type VisitState =
  | 'open'
  | 'in_triage'
  | 'awaiting_clinician'
  | 'in_care'
  | 'awaiting_service'
  | 'complete'
  | 'on_hold'
  | 'cancelled';
export const VISIT_TRANSITIONS: Transitions<VisitState> = {
  open: ['in_triage', 'on_hold', 'cancelled'],
  in_triage: ['awaiting_clinician', 'on_hold', 'cancelled'],
  awaiting_clinician: ['in_care', 'on_hold', 'cancelled'],
  in_care: ['awaiting_service', 'complete', 'on_hold'],
  awaiting_service: ['complete', 'in_care', 'on_hold'],
  complete: [],
  on_hold: ['open', 'in_triage', 'awaiting_clinician', 'in_care', 'awaiting_service', 'cancelled'],
  cancelled: [],
};

// --- Order (pack §13.1)
export type OrderState = 'draft' | 'active' | 'accepted' | 'in_progress' | 'completed' | 'cancelled' | 'declined' | 'not_performed';
export const ORDER_TRANSITIONS: Transitions<OrderState> = {
  draft: ['active', 'cancelled'],
  active: ['accepted', 'cancelled', 'declined'],
  accepted: ['in_progress', 'cancelled', 'not_performed'],
  in_progress: ['completed', 'cancelled', 'not_performed'],
  completed: [],
  cancelled: [],
  declined: [],
  not_performed: [],
};
