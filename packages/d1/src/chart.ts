/**
 * Chart-of-accounts, cost-centre and dimension administration on D1 (FIN-001).
 * Account definitions are effective-dated (revising adds a new version and closes
 * the prior — codes and posted history are never rewritten); cost centres and
 * dimensions are registries; every change is audited as a config action. The
 * domain layer validates codes/types and resolves the definition in force on a
 * date. Ported from the Postgres edge `chart.ts`.
 *
 * D1 translations: interactive tx → db.batch(); booleans are INTEGER 0/1 (mapped
 * back to boolean on read for the domain types).
 */
import { uuidv7, assertAccountCode, assertAccountType, resolveAccount, chartAsOf, type AccountType, type AccountVersion } from '@sancta/domain';
import type { D1Database, D1PreparedStatement } from './d1.ts';
import { one, many, stmt } from './query.ts';

export class ChartAdminError extends Error {}

function auditStmt(db: D1Database, by: string | undefined, resourceType: string, code: string, reason: string): D1PreparedStatement {
  return stmt(db, `INSERT INTO audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, event_hash) VALUES (?,?,'config',?,?,'success',?,?)`,
    [uuidv7(), by ?? null, resourceType, uuidv7(), `[${code}] ${reason}`, `${resourceType}:${code}:${uuidv7()}`]);
}

// --- Cost centres ----------------------------------------------------------

export async function createCostCentre(db: D1Database, args: { code: string; name: string; by?: string }): Promise<{ code: string }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new ChartAdminError('cost centre code and name are required');
  try {
    await db.batch([
      stmt(db, `INSERT INTO finance_cost_centre (code, name) VALUES (?,?)`, [args.code, args.name]),
      auditStmt(db, args.by, 'cost_centre', args.code, `created cost centre ${args.name}`),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) throw new ChartAdminError(`cost centre ${args.code} already exists`);
    throw e;
  }
  return { code: args.code };
}

export async function listCostCentres(db: D1Database): Promise<Array<{ code: string; name: string; active: boolean }>> {
  const rows = await many<{ code: string; name: string; active: number }>(db, `SELECT code, name, active FROM finance_cost_centre ORDER BY code`);
  return rows.map((r) => ({ code: r.code, name: r.name, active: !!r.active }));
}

/** Posting-choke-point guard: reject an unknown or inactive cost centre. */
export async function assertCostCentreActive(db: D1Database, code: string): Promise<void> {
  const r = await one<{ active: number }>(db, `SELECT active FROM finance_cost_centre WHERE code=?`, [code]);
  if (!r) throw new ChartAdminError(`unknown cost centre "${code}"`);
  if (!r.active) throw new ChartAdminError(`cost centre "${code}" is inactive`);
}

// --- Accounts (versioned) --------------------------------------------------

async function loadVersions(db: D1Database, code: string): Promise<AccountVersion[]> {
  const rows = await many<{ code: string; version: number; name: string; type: string; active: number; parent_code: string | null; effective_from: string; effective_to: string | null }>(
    db, `SELECT code, version, name, type, active, parent_code, effective_from, effective_to FROM finance_account_version WHERE code=? ORDER BY version`, [code]);
  return rows.map((x) => ({
    code: x.code, version: x.version, name: x.name, type: x.type as AccountType, active: !!x.active,
    ...(x.parent_code ? { parentCode: x.parent_code } : {}),
    effectiveFrom: x.effective_from,
    ...(x.effective_to ? { effectiveTo: x.effective_to } : {}),
  }));
}

/** Define a NEW account (code + version 1). Rejects a duplicate code. */
export async function defineAccount(db: D1Database, args: { code: string; name: string; type: string; parentCode?: string; effectiveFrom: string; by?: string }): Promise<{ code: string; version: number }> {
  assertAccountCode(args.code);
  assertAccountType(args.type);
  const exists = await one(db, `SELECT 1 AS ok FROM finance_account WHERE code=?`, [args.code]);
  if (exists) throw new ChartAdminError(`account ${args.code} already exists; use reviseAccount`);
  await db.batch([
    stmt(db, `INSERT INTO finance_account (code, name, type, active) VALUES (?,?,?,1)`, [args.code, args.name, args.type]),
    stmt(db, `INSERT INTO finance_account_version (id, code, version, name, type, active, parent_code, effective_from, changed_by) VALUES (?,?,1,?,?,1,?,?,?)`,
      [uuidv7(), args.code, args.name, args.type, args.parentCode ?? null, args.effectiveFrom, args.by ?? null]),
    auditStmt(db, args.by, 'account', args.code, `defined account ${args.name} (${args.type})`),
  ]);
  return { code: args.code, version: 1 };
}

/** Revise an account: add a new effective-dated version, close the prior one, and
 * mirror the latest onto the account row. History is preserved. */
export async function reviseAccount(db: D1Database, args: { code: string; name?: string; type?: string; active?: boolean; parentCode?: string; effectiveFrom: string; by?: string }): Promise<{ code: string; version: number }> {
  if (args.type !== undefined) assertAccountType(args.type);
  const versions = await loadVersions(db, args.code);
  const latest = versions.sort((a, b) => b.version - a.version)[0];
  if (!latest) throw new ChartAdminError(`account ${args.code} does not exist; use defineAccount`);
  if (args.effectiveFrom <= latest.effectiveFrom) throw new ChartAdminError(`new effective date must be after the current version's (${latest.effectiveFrom})`);
  const next = latest.version + 1;
  const name = args.name ?? latest.name;
  const type = (args.type ?? latest.type) as AccountType;
  const active = args.active ?? latest.active;
  const parentCode = args.parentCode ?? latest.parentCode ?? null;
  await db.batch([
    stmt(db, `UPDATE finance_account_version SET effective_to=? WHERE code=? AND version=?`, [args.effectiveFrom, args.code, latest.version]),
    stmt(db, `INSERT INTO finance_account_version (id, code, version, name, type, active, parent_code, effective_from, changed_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [uuidv7(), args.code, next, name, type, active ? 1 : 0, parentCode, args.effectiveFrom, args.by ?? null]),
    stmt(db, `UPDATE finance_account SET name=?, type=?, active=? WHERE code=?`, [name, type, active ? 1 : 0, args.code]),
    auditStmt(db, args.by, 'account', args.code, `revised to v${next}: ${name} (${type}${active ? '' : ', inactive'})`),
  ]);
  return { code: args.code, version: next };
}

/** The definition of an account in force on a date (FIN-001 versioned codes). */
export async function accountAsOf(db: D1Database, code: string, onDate: string): Promise<AccountVersion> {
  return resolveAccount(await loadVersions(db, code), code, onDate);
}

/** The active chart of accounts as-of a date. */
export async function chartOfAccounts(db: D1Database, onDate: string): Promise<AccountVersion[]> {
  const rows = await many<{ code: string; version: number; name: string; type: string; active: number; parent_code: string | null; effective_from: string; effective_to: string | null }>(
    db, `SELECT code, version, name, type, active, parent_code, effective_from, effective_to FROM finance_account_version`);
  const versions: AccountVersion[] = rows.map((x) => ({
    code: x.code, version: x.version, name: x.name, type: x.type as AccountType, active: !!x.active,
    ...(x.parent_code ? { parentCode: x.parent_code } : {}),
    effectiveFrom: x.effective_from,
    ...(x.effective_to ? { effectiveTo: x.effective_to } : {}),
  }));
  return chartAsOf(versions, onDate);
}

// --- Dimensions ------------------------------------------------------------

export async function createDimension(db: D1Database, args: { code: string; name: string; by?: string }): Promise<{ code: string }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new ChartAdminError('dimension code and name are required');
  try {
    await db.batch([
      stmt(db, `INSERT INTO finance_dimension (code, name) VALUES (?,?)`, [args.code, args.name]),
      auditStmt(db, args.by, 'dimension', args.code, `created dimension ${args.name}`),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) throw new ChartAdminError(`dimension ${args.code} already exists`);
    throw e;
  }
  return { code: args.code };
}

export async function addDimensionValue(db: D1Database, args: { dimensionCode: string; valueCode: string; label: string; by?: string }): Promise<{ dimensionCode: string; valueCode: string }> {
  const dim = await one(db, `SELECT 1 AS ok FROM finance_dimension WHERE code=?`, [args.dimensionCode]);
  if (!dim) throw new ChartAdminError(`unknown dimension "${args.dimensionCode}"`);
  await db.batch([
    stmt(db, `INSERT INTO finance_dimension_value (dimension_code, value_code, label) VALUES (?,?,?)`, [args.dimensionCode, args.valueCode, args.label]),
    auditStmt(db, args.by, 'dimension_value', `${args.dimensionCode}/${args.valueCode}`, `added value ${args.label}`),
  ]);
  return { dimensionCode: args.dimensionCode, valueCode: args.valueCode };
}

export async function listDimensions(db: D1Database): Promise<Array<{ code: string; name: string; values: Array<{ valueCode: string; label: string; active: boolean }> }>> {
  const dims = await many<{ code: string; name: string }>(db, `SELECT code, name FROM finance_dimension WHERE active=1 ORDER BY code`);
  const vals = await many<{ dimension_code: string; value_code: string; label: string; active: number }>(db, `SELECT dimension_code, value_code, label, active FROM finance_dimension_value ORDER BY dimension_code, value_code`);
  return dims.map((d) => ({
    code: d.code, name: d.name,
    values: vals.filter((v) => v.dimension_code === d.code).map((v) => ({ valueCode: v.value_code, label: v.label, active: !!v.active })),
  }));
}
