/**
 * Typed token references — UI/UX spec §6. These are the *names* of the CSS custom
 * properties in tokens.css, so TS code (inline styles, canvas, chart libraries)
 * resolves the same single source of truth. Import tokens.css once at the app root;
 * reference `token('colour-danger')` etc. here.
 *
 * Design rule (§6.1): components expose SEMANTIC intent (tone="danger"), never raw
 * colour. `Tone` is that intent vocabulary.
 */

export type Tone = 'neutral' | 'action' | 'success' | 'warning' | 'danger' | 'info';

/** Map a semantic tone to its solid + subtle colour custom properties. */
export const toneColour: Record<Tone, { solid: string; subtle: string; onSubtle: string }> = {
  neutral: { solid: 'var(--sancta-colour-text-secondary)', subtle: 'var(--sancta-colour-surface-subtle)', onSubtle: 'var(--sancta-colour-text)' },
  action: { solid: 'var(--sancta-colour-action)', subtle: 'var(--sancta-colour-action-subtle)', onSubtle: 'var(--sancta-colour-action-hover)' },
  success: { solid: 'var(--sancta-colour-success)', subtle: 'var(--sancta-colour-success-subtle)', onSubtle: 'var(--sancta-colour-success)' },
  warning: { solid: 'var(--sancta-colour-warning)', subtle: 'var(--sancta-colour-warning-subtle)', onSubtle: 'var(--sancta-colour-warning)' },
  danger: { solid: 'var(--sancta-colour-danger)', subtle: 'var(--sancta-colour-danger-subtle)', onSubtle: 'var(--sancta-colour-danger)' },
  info: { solid: 'var(--sancta-colour-info)', subtle: 'var(--sancta-colour-info-subtle)', onSubtle: 'var(--sancta-colour-info)' },
};

/** Spacing scale (px values) — for computed layouts; prefer the CSS var in styles. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 16: 64 } as const;

/** The 18 canonical UI states every applicable screen/component must model (master §6.6). */
export const UI_STATES = [
  'initial-loading', 'ready', 'draft', 'saving', 'saved-to-clinic', 'waiting-to-sync',
  'synchronising', 'synced', 'stale', 'empty', 'filtered-empty', 'validation-error',
  'permission-limited', 'business-blocked', 'failed', 'conflict', 'completed', 'locked',
] as const;
export type UiState = (typeof UI_STATES)[number];

/** Connectivity model (§10) — availability is NOT navigator.onLine. */
export const CONNECTIVITY_STATES = [
  'fully-connected', 'cloud-unavailable', 'clinic-unavailable', 'synchronising', 'action-needed', 'stale-cloud',
] as const;
export type ConnectivityState = (typeof CONNECTIVITY_STATES)[number];

/** Density modes (§5.3). Comfortable is default; compact only for desktop tables/workboards. */
export type Density = 'comfortable' | 'compact';

export const focus = { width: 2, offset: 2 } as const;
export const touchTarget = { min: 44, compactMin: 32 } as const;
