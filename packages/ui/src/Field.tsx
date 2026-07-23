/**
 * Field (spec §12). Visible label ABOVE the control (never placeholder-as-label),
 * `Optional` marker on optional fields, format hint before entry, permanent units/
 * currency adornment for clinical/financial values, error linked to the control via
 * aria-describedby and repeated beside the field. Numeric fields use tabular figures,
 * right-align, and block mouse-wheel value changes (§6.8).
 */
import { useId } from 'react';
import type { InputHTMLAttributes, JSX, ReactNode } from 'react';

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> & {
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  /** Permanent leading adornment, e.g. a currency symbol. */
  prefix?: ReactNode;
  /** Permanent trailing adornment, e.g. a unit (mmHg, kg, mg). */
  suffix?: ReactNode;
  /** Numeric presentation + wheel-guard. */
  numeric?: boolean;
};

export function Field({ label, optional, hint, error, prefix, suffix, numeric, type, ...rest }: FieldProps): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="sancta-field" data-invalid={error ? 'true' : undefined}>
      <label className="sancta-field__label" htmlFor={id}>
        {label}{optional ? <span className="sancta-field__optional"> (Optional)</span> : null}
      </label>
      {hint ? <span className="sancta-field__hint" id={hintId}>{hint}</span> : null}
      <div className="sancta-field__control">
        {prefix ? <span className="sancta-field__adornment sancta-field__adornment--prefix" aria-hidden="true">{prefix}</span> : null}
        <input
          id={id}
          className="sancta-field-input"
          data-numeric={numeric ? 'true' : undefined}
          type={type ?? (numeric ? 'text' : undefined)}
          inputMode={numeric ? 'decimal' : rest.inputMode}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          // §6.8 — a scroll must never change a numeric value.
          onWheel={numeric ? (e) => (e.target as HTMLInputElement).blur() : rest.onWheel}
          {...rest}
        />
        {suffix ? <span className="sancta-field__adornment sancta-field__adornment--suffix" aria-hidden="true">{suffix}</span> : null}
      </div>
      {suffix ? <span className="sancta-visually-hidden">{`Unit: ${typeof suffix === 'string' ? suffix : ''}`}</span> : null}
      {error ? <span className="sancta-field__error" id={errId}>{error}</span> : null}
    </div>
  );
}
