/**
 * Instance environment identity on D1/Worker (ADM-007, §16). Production, training
 * and test instances are separated and non-production instances are clearly MARKED
 * so no one mistakes a training system for the real record — and so PHI is never
 * copied into a non-production environment. The mode comes from configuration
 * (the Worker's SANCTA_ENV binding); anything not explicitly "production" is
 * treated as non-production (fail-safe marking). Ported from the Postgres edge
 * `instance.ts`; refactored to take the raw mode string so the barrel stays
 * runtime-neutral (no process.env).
 */

export type InstanceMode = 'production' | 'training' | 'test';

export type InstanceInfo = {
  mode: InstanceMode;
  nonProduction: boolean;
  /** A human banner for non-production instances (empty for production). */
  banner: string;
  /** Non-production instances must contain synthetic data only (ADM-007). */
  syntheticDataOnly: boolean;
};

export function resolveMode(raw: string | undefined): InstanceMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'production' || v === 'prod') return 'production';
  if (v === 'training' || v === 'train') return 'training';
  return 'test'; // fail-safe: unknown/empty → treat as a non-production test instance
}

export function instanceInfo(rawMode: string | undefined): InstanceInfo {
  const mode = resolveMode(rawMode);
  const nonProduction = mode !== 'production';
  return {
    mode,
    nonProduction,
    banner: nonProduction ? `NON-PRODUCTION (${mode.toUpperCase()}) — synthetic data only, not for clinical use` : '',
    syntheticDataOnly: nonProduction,
  };
}
