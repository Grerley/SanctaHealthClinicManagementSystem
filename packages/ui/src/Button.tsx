/**
 * Button (spec §7.1). Semantic API: variant (primary/secondary/subtle) + tone, not
 * raw colour. One dominant primary action per area is a screen-level rule, not
 * enforced here. A disabled primary MUST explain what is missing — pass
 * `disabledReason`, surfaced as the accessible description and a tooltip, rather
 * than a bare disabled control (§6.5).
 */
import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import type { Tone, Density } from '@sancta/design-tokens';

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  variant?: 'primary' | 'secondary' | 'subtle';
  tone?: Extract<Tone, 'action' | 'danger'>;
  density?: Density;
  /** When set, the button is disabled AND the reason is announced (never a silent disable). */
  disabledReason?: string;
  icon?: ReactNode;
  children: ReactNode;
};

export function Button({ variant = 'secondary', tone = 'action', density = 'comfortable', disabledReason, icon, children, disabled, type = 'button', ...rest }: ButtonProps): JSX.Element {
  const isDisabled = disabled || Boolean(disabledReason);
  return (
    <button
      type={type}
      className="sancta-btn"
      data-variant={variant}
      data-tone={tone}
      data-size={density === 'compact' ? 'compact' : undefined}
      // aria-disabled (not the disabled attribute) keeps the control focusable so a
      // screen-reader user can reach the explanation; click is guarded below.
      aria-disabled={isDisabled || undefined}
      aria-describedby={rest['aria-describedby']}
      title={disabledReason}
      onClick={(e) => {
        if (isDisabled) { e.preventDefault(); return; }
        rest.onClick?.(e);
      }}
      {...rest}
    >
      {icon}
      <span>{children}</span>
      {disabledReason ? <span className="sancta-visually-hidden">{`. Unavailable: ${disabledReason}`}</span> : null}
    </button>
  );
}
