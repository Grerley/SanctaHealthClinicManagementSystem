/**
 * StateBlock (spec §6.6) — the shared renderer for the "whole area" states: empty,
 * filtered-empty, stale, permission-limited, business-blocked, failed, conflict,
 * initial-loading, locked. Enforces the honest-copy contract (title + what's
 * preserved / next / action) and an optional recovery action. Keeps screens from
 * inventing ad-hoc empty/error states.
 */
import type { JSX, ReactNode } from 'react';
import type { UiState } from '@sancta/design-tokens';
import { statePresentation } from './state.ts';
import { Icon, type IconName } from './icons.tsx';

const STATE_ICON: Partial<Record<UiState, IconName>> = {
  'initial-loading': 'sync', empty: 'info', 'filtered-empty': 'info', stale: 'stale',
  'permission-limited': 'lock', 'business-blocked': 'alert', failed: 'alert', conflict: 'alert', locked: 'lock',
};

export function StateBlock({ state, title, children, action }: { state: UiState; title?: string; children?: ReactNode; action?: ReactNode }): JSX.Element {
  const p = statePresentation(state);
  const icon = STATE_ICON[state];
  const live = p.announce === 'assertive' ? 'assertive' : p.announce === 'polite' ? 'polite' : undefined;
  return (
    <div className="sancta-state" role={p.announce === 'assertive' ? 'alert' : 'status'} aria-live={live} data-state={state}>
      {icon ? <Icon name={icon} size={22} /> : null}
      <div className="sancta-state__title">{title ?? p.label}</div>
      {children ? <div>{children}</div> : null}
      {action}
    </div>
  );
}
