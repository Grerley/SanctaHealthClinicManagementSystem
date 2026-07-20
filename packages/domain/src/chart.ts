/**
 * Chart of accounts — versioned account definitions (FIN-001, pack §10).
 *
 * An account CODE is stable and permanent (journal lines reference it forever),
 * but its human-facing definition — name, type, active flag, parent — is
 * effective-dated so a rename or reclassification never rewrites history. The
 * definition in force on a given date is resolved the same way prices are
 * (highest version whose window covers the date). Codes and types are validated
 * so a typo cannot enter the ledger.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export const ACCOUNT_TYPES: readonly AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

export type AccountVersion = {
  readonly code: string;
  readonly version: number;
  readonly name: string;
  readonly type: AccountType;
  readonly active: boolean;
  readonly parentCode?: string;
  readonly effectiveFrom: string; // ISO date, inclusive
  readonly effectiveTo?: string; // ISO date, exclusive; open-ended if absent
};

export class ChartError extends Error {}

export function isAccountType(t: string): t is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(t);
}

export function assertAccountType(t: string): asserts t is AccountType {
  if (!isAccountType(t)) throw new ChartError(`invalid account type "${t}" (expected one of ${ACCOUNT_TYPES.join(', ')})`);
}

/** Account codes are UPPER-KEBAB with a numeric prefix, e.g. 4000-SERVICE-REVENUE. */
const CODE_RE = /^[0-9]{3,4}-[A-Z0-9-]+$/;
export function assertAccountCode(code: string): void {
  if (!CODE_RE.test(code)) throw new ChartError(`invalid account code "${code}" (expected NNNN-UPPER-KEBAB)`);
}

function isEffective(v: AccountVersion, onDate: string): boolean {
  if (onDate < v.effectiveFrom) return false;
  if (v.effectiveTo !== undefined && onDate >= v.effectiveTo) return false;
  return true;
}

/** Resolve the account definition in force on a date. Throws if none applies. */
export function resolveAccount(versions: readonly AccountVersion[], code: string, onDate: string): AccountVersion {
  const found = versions
    .filter((v) => v.code === code && isEffective(v, onDate))
    .sort((a, b) => b.version - a.version)[0];
  if (!found) throw new ChartError(`no effective definition for account ${code} on ${onDate}`);
  return found;
}

/** The chart as-of a date: the active definition of every code with one. */
export function chartAsOf(versions: readonly AccountVersion[], onDate: string): AccountVersion[] {
  const codes = [...new Set(versions.map((v) => v.code))];
  const out: AccountVersion[] = [];
  for (const code of codes) {
    const eff = versions
      .filter((v) => v.code === code && isEffective(v, onDate))
      .sort((a, b) => b.version - a.version)[0];
    if (eff && eff.active) out.push(eff);
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}
