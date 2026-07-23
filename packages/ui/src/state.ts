/**
 * The canonical UI-state contract (master §6.6, spec §6/§9). Pure, framework-free
 * so it is unit-testable and shared by every screen. Each of the 18 states maps to
 * a tone, a short human label, and whether it is a "resting" state (safe to leave)
 * or needs attention. The 5-part copy contract is composed here so no screen has to
 * reinvent honest status language.
 */
import type { Tone, UiState } from '@sancta/design-tokens';

export type StatePresentation = {
  state: UiState;
  tone: Tone;
  /** Short label for a tag/badge. */
  label: string;
  /** True when the state needs the user to do or notice something. */
  needsAttention: boolean;
  /** True when work is durably held (draft/clinic/synced) — never say "lost". */
  preserved: boolean;
  /** Whether a screen-reader live region should announce this (assertive vs polite vs none). */
  announce: 'assertive' | 'polite' | 'off';
};

const P = (state: UiState, tone: Tone, label: string, opts: Partial<StatePresentation> = {}): StatePresentation => ({
  state, tone, label,
  needsAttention: opts.needsAttention ?? false,
  preserved: opts.preserved ?? false,
  announce: opts.announce ?? 'off',
});

const TABLE: Record<UiState, StatePresentation> = {
  'initial-loading': P('initial-loading', 'neutral', 'Loading', { announce: 'polite' }),
  ready: P('ready', 'neutral', 'Ready'),
  draft: P('draft', 'info', 'Draft', { preserved: true }),
  saving: P('saving', 'info', 'Saving', { announce: 'polite' }),
  'saved-to-clinic': P('saved-to-clinic', 'success', 'Saved to clinic', { preserved: true, announce: 'polite' }),
  'waiting-to-sync': P('waiting-to-sync', 'warning', 'Waiting to sync', { preserved: true, announce: 'polite' }),
  synchronising: P('synchronising', 'info', 'Synchronising', { preserved: true, announce: 'polite' }),
  synced: P('synced', 'success', 'Synced', { preserved: true }),
  stale: P('stale', 'warning', 'May be out of date', { needsAttention: true }),
  empty: P('empty', 'neutral', 'Nothing yet'),
  'filtered-empty': P('filtered-empty', 'neutral', 'No matches'),
  'validation-error': P('validation-error', 'danger', 'Check the highlighted fields', { needsAttention: true, announce: 'assertive' }),
  'permission-limited': P('permission-limited', 'neutral', 'Not permitted', { needsAttention: true }),
  'business-blocked': P('business-blocked', 'warning', 'Blocked', { needsAttention: true, announce: 'assertive' }),
  failed: P('failed', 'danger', 'Could not complete', { needsAttention: true, preserved: true, announce: 'assertive' }),
  conflict: P('conflict', 'danger', 'Needs review', { needsAttention: true, preserved: true, announce: 'assertive' }),
  completed: P('completed', 'success', 'Done', { preserved: true, announce: 'polite' }),
  locked: P('locked', 'neutral', 'Locked', { needsAttention: false }),
};

export function statePresentation(state: UiState): StatePresentation {
  return TABLE[state]!;
}

/**
 * The 5-part status message (master §6.6): what happened, what is preserved,
 * whether clinic/cloud received it, what happens next, what the user should do.
 * Omitted parts are dropped so the copy stays terse. Never claims cloud receipt
 * for queued work (§10.8).
 */
export type StatusCopyParts = {
  happened: string;
  preserved?: string;
  receipt?: string;
  next?: string;
  action?: string;
};

export function composeStatusCopy(parts: StatusCopyParts): string {
  return [parts.happened, parts.preserved, parts.receipt, parts.next, parts.action]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(' ');
}
