/**
 * Minimal inline icon set (spec §6.5). Icons are decorative here (aria-hidden) and
 * are ALWAYS paired with a visible text label by the consuming component — never an
 * unlabelled icon for a critical action, never colour/icon as the only signal.
 */
import type { JSX } from 'react';

type IconProps = { size?: number };

function svg(path: JSX.Element, size: number): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {path}
    </svg>
  );
}

export type IconName = 'linked' | 'cloud-off' | 'disconnected' | 'sync' | 'alert' | 'stale' | 'check' | 'info' | 'lock' | 'draft';

export function Icon({ name, size = 14 }: { name: IconName } & IconProps): JSX.Element {
  switch (name) {
    case 'linked': return svg(<><path d="M6.5 9.5l3-3" /><path d="M9 5l1-1a2.1 2.1 0 013 3l-1 1" /><path d="M7 11l-1 1a2.1 2.1 0 01-3-3l1-1" /></>, size);
    case 'cloud-off': return svg(<><path d="M4 12h7a2.5 2.5 0 00.4-5A3.5 3.5 0 005 6" /><path d="M2 2l12 12" /></>, size);
    case 'disconnected': return svg(<><path d="M8 3v3" /><path d="M8 10v3" /><path d="M4.5 8h2" /><path d="M9.5 8h2" /><path d="M2 2l12 12" /></>, size);
    case 'sync': return svg(<><path d="M13 7a5 5 0 00-9-2.5L3 6" /><path d="M3 3v3h3" /><path d="M3 9a5 5 0 009 2.5L13 10" /><path d="M13 13v-3h-3" /></>, size);
    case 'alert': return svg(<><path d="M8 2l6 11H2z" /><path d="M8 6.5v3" /><path d="M8 11.5h.01" /></>, size);
    case 'stale': return svg(<><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 1" /></>, size);
    case 'check': return svg(<path d="M3 8.5l3 3 7-7" />, size);
    case 'info': return svg(<><circle cx="8" cy="8" r="6" /><path d="M8 7.5v3" /><path d="M8 5.5h.01" /></>, size);
    case 'lock': return svg(<><rect x="3.5" y="7" width="9" height="6" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></>, size);
    case 'draft': return svg(<><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></>, size);
  }
}
