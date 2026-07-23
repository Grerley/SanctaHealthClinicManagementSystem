/**
 * StatusTag (spec §11.3). Always text + (optional) icon — never colour alone. Not
 * interactive (tags are not buttons, §6.5). Can be driven directly from a UiState
 * via `fromState`.
 */
import type { JSX } from 'react';
import type { Tone, UiState } from '@sancta/design-tokens';
import { Icon, type IconName } from './icons.tsx';
import { statePresentation } from './state.ts';

const TONE_ICON: Record<Tone, IconName> = {
  neutral: 'info', action: 'info', success: 'check', warning: 'alert', danger: 'alert', info: 'info',
};

export function StatusTag({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: IconName | null; children: string }): JSX.Element {
  const glyph = icon === null ? null : <Icon name={icon ?? TONE_ICON[tone] ?? 'info'} />;
  return (
    <span className="sancta-tag" data-tone={tone}>
      {glyph}
      <span>{children}</span>
    </span>
  );
}

/** Render a tag straight from one of the 18 canonical UI states. */
export function StateTag({ state }: { state: UiState }): JSX.Element {
  const p = statePresentation(state);
  return <StatusTag tone={p.tone}>{p.label}</StatusTag>;
}
