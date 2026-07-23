/**
 * ConnectivityIndicator (spec §10.2). Renders the honest, derived connectivity copy
 * with a paired icon + text (never colour alone). Announces changes politely so a
 * screen-reader user hears "14 items waiting to sync" without losing focus.
 */
import type { JSX } from 'react';
import { connectivityPresentation, type ConnectivityInputs } from './connectivity.ts';
import { Icon } from './icons.tsx';

export function ConnectivityIndicator(inputs: ConnectivityInputs): JSX.Element {
  const p = connectivityPresentation(inputs);
  return (
    <span className="sancta-conn" data-tone={p.tone} role="status" aria-live="polite" data-testid="connectivity">
      <span className="sancta-conn__dot" aria-hidden="true" />
      <Icon name={p.icon} />
      <span>{p.copy}</span>
    </span>
  );
}
