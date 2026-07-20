/**
 * API contract gate (pack §22 reserved gate). Enforces that the committed OpenAPI
 * contract (docs/api/openapi.json) and the edge implementation agree:
 *
 *   1. every implemented /api route is documented (no undocumented endpoint);
 *   2. every documented operation is implemented (no phantom documentation);
 *   3. each operation's declared x-permission matches the permission the server
 *      actually enforces (requiredPermission) — so the contract cannot claim an
 *      endpoint is protected when it is not, or vice versa;
 *   4. the document is structurally an OpenAPI 3.x spec.
 *
 * Deterministic, no network, no database. Run `npm run openapi:gen` to refresh the
 * contract after a route change; this check then keeps it honest. Exits non-zero
 * on any drift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractRoutes, repoRoot } from './lib/routes.ts';

type Op = { 'x-permission'?: string | null };
type Spec = { openapi?: string; info?: { title?: string; version?: string }; paths?: Record<string, Record<string, Op>> };

const spec = JSON.parse(readFileSync(join(repoRoot, 'docs/api/openapi.json'), 'utf8')) as Spec;
const errors: string[] = [];

// (4) structural sanity.
if (!spec.openapi || !/^3\./.test(spec.openapi)) errors.push(`openapi version missing or not 3.x (got ${spec.openapi ?? 'none'})`);
if (!spec.info?.title || !spec.info?.version) errors.push('info.title and info.version are required');

const routes = extractRoutes();
const implemented = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));

// Build the documented operation set.
const documented = new Map<string, Op>();
for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(methods)) {
    documented.set(`${method.toUpperCase()} ${path}`, op);
  }
}

// (1) every implemented route is documented + (3) permission agreement.
for (const [key, route] of implemented) {
  const op = documented.get(key);
  if (!op) {
    errors.push(`undocumented endpoint: ${key} (add it — run npm run openapi:gen)`);
    continue;
  }
  const declared = op['x-permission'] ?? null;
  if (declared !== route.permission) {
    errors.push(`permission drift on ${key}: contract says ${declared ?? 'public'}, server enforces ${route.permission ?? 'public'}`);
  }
}

// (2) every documented operation is implemented.
for (const key of documented.keys()) {
  if (!implemented.has(key)) errors.push(`phantom documentation: ${key} is documented but not implemented`);
}

if (errors.length > 0) {
  console.error(`\n✖ contract-check: ${errors.length} discrepancy(ies) between docs/api/openapi.json and the edge API:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nRefresh the contract with `npm run openapi:gen` (and review the diff), or fix the route.');
  process.exit(1);
}
console.log(`✓ contract-check: ${implemented.size} operations — contract and implementation agree (routes + permissions).`);
