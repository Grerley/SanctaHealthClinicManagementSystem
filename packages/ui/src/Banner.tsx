/**
 * Banner (spec §6.6 / §11). Communicates a state with the 5-part honest copy. Uses
 * role="status" (polite) by default; danger/blocked use role="alert" (assertive).
 * Text + icon, never colour alone.
 */
import type { JSX, ReactNode } from 'react';
import type { Tone } from '@sancta/design-tokens';
import { Icon, type IconName } from './icons.tsx';

const TONE_ICON: Record<Tone, IconName> = {
  neutral: 'info', action: 'info', success: 'check', warning: 'alert', danger: 'alert', info: 'info',
};

export function Banner({ tone = 'info', title, children, assertive }: { tone?: Tone; title?: string; children?: ReactNode; assertive?: boolean }): JSX.Element {
  const isAssertive = assertive ?? (tone === 'danger');
  return (
    <div className="sancta-banner" data-tone={tone} role={isAssertive ? 'alert' : 'status'} aria-live={isAssertive ? 'assertive' : 'polite'}>
      <span className="sancta-banner__icon"><Icon name={TONE_ICON[tone] ?? 'info'} size={18} /></span>
      <div>
        {title ? <div className="sancta-banner__title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}
