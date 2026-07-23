/**
 * Connectivity presentation (spec §10.2). Availability is NOT navigator.onLine:
 * we model clinic reachability, cloud sync and pending/failed counts separately and
 * derive honest shell copy. Pure + testable. The exact reference strings from
 * §10.2 are used so copy review is deterministic.
 */
import type { ConnectivityState, Tone } from '@sancta/design-tokens';

export type ConnectivityInputs = {
  /** Is the clinic hub (the Worker/D1 API) reachable? */
  clinicReachable: boolean;
  /** Is the cloud reachable / recently synced? (In the single-Worker model this is the same origin.) */
  cloudReachable: boolean;
  /** Items written locally but not yet confirmed synced. */
  pendingCount: number;
  /** Minutes since the last successful cloud sync, if known. */
  syncedMinutesAgo?: number;
  /** True while a sync pass is actively running. */
  synchronising?: boolean;
};

export type ConnectivityPresentation = {
  state: ConnectivityState;
  copy: string;
  tone: Tone;
  /** Icon name (paired with visible copy — never colour/icon alone, §6.5). */
  icon: 'linked' | 'cloud-off' | 'disconnected' | 'sync' | 'alert' | 'stale';
};

function agoPhrase(min: number | undefined): string {
  if (min === undefined) return 'recently';
  if (min <= 0) return 'just now';
  if (min === 1) return '1 minute ago';
  if (min < 60) return `${min} minutes ago`;
  const h = Math.floor(min / 60);
  return h === 1 ? '1 hour ago' : `${h} hours ago`;
}

export function connectivityPresentation(i: ConnectivityInputs): ConnectivityPresentation {
  // Clinic hub unreachable is the most serious — device work is limited (§10.2).
  if (!i.clinicReachable) {
    return { state: 'clinic-unavailable', copy: 'Clinic connection lost. Work on this device is limited.', tone: 'danger', icon: 'disconnected' };
  }
  if (i.synchronising) {
    return { state: 'synchronising', copy: `Clinic connected. Synchronising ${i.pendingCount} ${i.pendingCount === 1 ? 'item' : 'items'}.`, tone: 'info', icon: 'sync' };
  }
  if (i.pendingCount > 0) {
    return { state: 'cloud-unavailable', copy: `Clinic connected. ${i.pendingCount} ${i.pendingCount === 1 ? 'item' : 'items'} waiting to sync.`, tone: 'warning', icon: 'cloud-off' };
  }
  if (!i.cloudReachable) {
    return { state: 'cloud-unavailable', copy: 'Clinic connected. Cloud unavailable. Core clinic work continues.', tone: 'warning', icon: 'cloud-off' };
  }
  if (i.syncedMinutesAgo !== undefined && i.syncedMinutesAgo >= 60) {
    return { state: 'stale-cloud', copy: `Clinic connected. Cloud last synced ${agoPhrase(i.syncedMinutesAgo)}.`, tone: 'warning', icon: 'stale' };
  }
  return { state: 'fully-connected', copy: `Clinic connected. Cloud synced ${agoPhrase(i.syncedMinutesAgo)}.`, tone: 'success', icon: 'linked' };
}
