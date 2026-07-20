/**
 * Chart-of-accounts, cost-centre and dimension administration (FIN-001, pack §10).
 *
 * Reference data governed as configuration: account definitions are effective-
 * dated (revising an account adds a new version and closes the prior one — codes
 * and posted history are never rewritten), cost centres and dimensions are
 * registries, and every change is audited as a config action. The domain layer
 * validates codes/types and resolves the definition in force on a date. A helper
 * is exported for the posting choke point to reject unknown/inactive cost centres.
 */
import type { Pool, PoolClient } from 'pg';
import { uuidv7, assertAccountCode, assertAccountType, resolveAccount, chartAsOf, type AccountType, type AccountVersion } from '@sancta/domain';

export class ChartAdminError extends Error {}

async function audit(client: PoolClient, by: string | undefined, resourceType: string, code: string, reason: string): Promise<void> {
  // resource_id is a uuid column; reference data is keyed by text code, so the
  // code is carried in the reason and a fresh uuid stamps the event.
  await client.query(
    `INSERT INTO audit.audit_event (id, actor_user, action, resource_type, resource_id, outcome, reason, captured_at, event_hash)
     VALUES ($1,$2,'config',$3,$4,'success',$5, now(), $6)`,
    [uuidv7(), by ?? null, resourceType, uuidv7(), `[${code}] ${reason}`, `${resourceType}:${code}:${uuidv7()}`],
  );
}

// --- Cost centres ----------------------------------------------------------

export async function createCostCentre(pool: Pool, args: { code: string; name: string; by?: string }): Promise<{ code: string }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new ChartAdminError('cost centre code and name are required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO finance.cost_centre (code, name) VALUES ($1,$2)`, [args.code, args.name]);
    await audit(client, args.by, 'cost_centre', args.code, `created cost centre ${args.name}`);
    await client.query('COMMIT');
    return { code: args.code };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listCostCentres(pool: Pool): Promise<Array<{ code: string; name: string; active: boolean }>> {
  const r = await pool.query(`SELECT code, name, active FROM finance.cost_centre ORDER BY code`);
  return r.rows;
}

/** Posting-choke-point guard: reject an unknown or inactive cost centre. */
export async function assertCostCentreActive(client: PoolClient, code: string): Promise<void> {
  const r = await client.query(`SELECT active FROM finance.cost_centre WHERE code=$1`, [code]);
  if (r.rowCount === 0) throw new ChartAdminError(`unknown cost centre "${code}"`);
  if (r.rows[0].active !== true) throw new ChartAdminError(`cost centre "${code}" is inactive`);
}

// --- Accounts (versioned) --------------------------------------------------

async function loadVersions(client: PoolClient | Pool, code: string): Promise<AccountVersion[]> {
  const r = await client.query(
    `SELECT code, version, name, type, active, parent_code,
            to_char(effective_from,'YYYY-MM-DD') AS effective_from,
            to_char(effective_to,'YYYY-MM-DD') AS effective_to
     FROM finance.account_version WHERE code=$1 ORDER BY version`,
    [code],
  );
  return r.rows.map((x) => ({
    code: x.code,
    version: x.version,
    name: x.name,
    type: x.type as AccountType,
    active: x.active,
    ...(x.parent_code ? { parentCode: x.parent_code } : {}),
    effectiveFrom: x.effective_from,
    ...(x.effective_to ? { effectiveTo: x.effective_to } : {}),
  }));
}

/** Define a NEW account (code + version 1). Rejects a duplicate code. */
export async function defineAccount(
  pool: Pool,
  args: { code: string; name: string; type: string; parentCode?: string; effectiveFrom: string; by?: string },
): Promise<{ code: string; version: number }> {
  assertAccountCode(args.code);
  assertAccountType(args.type);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT 1 FROM finance.account WHERE code=$1`, [args.code]);
    if ((exists.rowCount ?? 0) > 0) throw new ChartAdminError(`account ${args.code} already exists; use reviseAccount`);
    await client.query(`INSERT INTO finance.account (code, name, type, active) VALUES ($1,$2,$3,true)`, [args.code, args.name, args.type]);
    await client.query(
      `INSERT INTO finance.account_version (id, code, version, name, type, active, parent_code, effective_from, changed_by)
       VALUES ($1,$2,1,$3,$4,true,$5,$6,$7)`,
      [uuidv7(), args.code, args.name, args.type, args.parentCode ?? null, args.effectiveFrom, args.by ?? null],
    );
    await audit(client, args.by, 'account', args.code, `defined account ${args.name} (${args.type})`);
    await client.query('COMMIT');
    return { code: args.code, version: 1 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Revise an existing account: add a new effective-dated version and close the
 * prior one at the new effective date. History is preserved; the mutable
 * `account` row mirrors the latest for FK/display convenience.
 */
export async function reviseAccount(
  pool: Pool,
  args: { code: string; name?: string; type?: string; active?: boolean; parentCode?: string; effectiveFrom: string; by?: string },
): Promise<{ code: string; version: number }> {
  if (args.type !== undefined) assertAccountType(args.type);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const versions = await loadVersions(client, args.code);
    const latest = versions.sort((a, b) => b.version - a.version)[0];
    if (!latest) throw new ChartAdminError(`account ${args.code} does not exist; use defineAccount`);
    if (args.effectiveFrom <= latest.effectiveFrom) throw new ChartAdminError(`new effective date must be after the current version's (${latest.effectiveFrom})`);

    const next = latest.version + 1;
    const name = args.name ?? latest.name;
    const type = (args.type ?? latest.type) as AccountType;
    const active = args.active ?? latest.active;
    const parentCode = args.parentCode ?? latest.parentCode ?? null;

    await client.query(`UPDATE finance.account_version SET effective_to=$2 WHERE code=$1 AND version=$3`, [args.code, args.effectiveFrom, latest.version]);
    await client.query(
      `INSERT INTO finance.account_version (id, code, version, name, type, active, parent_code, effective_from, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv7(), args.code, next, name, type, active, parentCode, args.effectiveFrom, args.by ?? null],
    );
    await client.query(`UPDATE finance.account SET name=$2, type=$3, active=$4 WHERE code=$1`, [args.code, name, type, active]);
    await audit(client, args.by, 'account', args.code, `revised to v${next}: ${name} (${type}${active ? '' : ', inactive'})`);
    await client.query('COMMIT');
    return { code: args.code, version: next };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** The definition of an account in force on a date (FIN-001 versioned codes). */
export async function accountAsOf(pool: Pool, code: string, onDate: string): Promise<AccountVersion> {
  const versions = await loadVersions(pool, code);
  return resolveAccount(versions, code, onDate);
}

/** The active chart of accounts as-of a date. */
export async function chartOfAccounts(pool: Pool, onDate: string): Promise<AccountVersion[]> {
  const r = await pool.query(
    `SELECT code, version, name, type, active, parent_code,
            to_char(effective_from,'YYYY-MM-DD') AS effective_from,
            to_char(effective_to,'YYYY-MM-DD') AS effective_to
     FROM finance.account_version`,
  );
  const versions: AccountVersion[] = r.rows.map((x) => ({
    code: x.code,
    version: x.version,
    name: x.name,
    type: x.type as AccountType,
    active: x.active,
    ...(x.parent_code ? { parentCode: x.parent_code } : {}),
    effectiveFrom: x.effective_from,
    ...(x.effective_to ? { effectiveTo: x.effective_to } : {}),
  }));
  return chartAsOf(versions, onDate);
}

// --- Dimensions ------------------------------------------------------------

export async function createDimension(pool: Pool, args: { code: string; name: string; by?: string }): Promise<{ code: string }> {
  if (!args.code?.trim() || !args.name?.trim()) throw new ChartAdminError('dimension code and name are required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO finance.dimension (code, name) VALUES ($1,$2)`, [args.code, args.name]);
    await audit(client, args.by, 'dimension', args.code, `created dimension ${args.name}`);
    await client.query('COMMIT');
    return { code: args.code };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function addDimensionValue(pool: Pool, args: { dimensionCode: string; valueCode: string; label: string; by?: string }): Promise<{ dimensionCode: string; valueCode: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dim = await client.query(`SELECT 1 FROM finance.dimension WHERE code=$1`, [args.dimensionCode]);
    if (dim.rowCount === 0) throw new ChartAdminError(`unknown dimension "${args.dimensionCode}"`);
    await client.query(`INSERT INTO finance.dimension_value (dimension_code, value_code, label) VALUES ($1,$2,$3)`, [args.dimensionCode, args.valueCode, args.label]);
    await audit(client, args.by, 'dimension_value', `${args.dimensionCode}/${args.valueCode}`, `added value ${args.label}`);
    await client.query('COMMIT');
    return { dimensionCode: args.dimensionCode, valueCode: args.valueCode };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listDimensions(pool: Pool): Promise<Array<{ code: string; name: string; values: Array<{ valueCode: string; label: string; active: boolean }> }>> {
  const dims = await pool.query(`SELECT code, name FROM finance.dimension WHERE active ORDER BY code`);
  const vals = await pool.query(`SELECT dimension_code, value_code, label, active FROM finance.dimension_value ORDER BY dimension_code, value_code`);
  return dims.rows.map((d) => ({
    code: d.code,
    name: d.name,
    values: vals.rows.filter((v) => v.dimension_code === d.code).map((v) => ({ valueCode: v.value_code, label: v.label, active: v.active })),
  }));
}
