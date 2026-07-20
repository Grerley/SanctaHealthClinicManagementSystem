/**
 * Bootstrap/refresh the edge API contract at docs/api/openapi.json from the
 * server's routes and their enforced permissions. Run after adding or changing a
 * route: `npm run openapi:gen`. The committed JSON is the reviewable contract;
 * `scripts/contract-check.ts` (CI) then enforces that code and contract agree.
 *
 * Human-authored per-path descriptions/schemas are preserved across regenerations
 * (merged by operationId), so this never clobbers hand-written documentation.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractRoutes, tagFor, repoRoot } from './lib/routes.ts';

const SPEC_PATH = join(repoRoot, 'docs/api/openapi.json');

function opId(method: string, path: string): string {
  const slug = path.replace(/^\//, '').replace(/[/-]/g, '_');
  return `${method.toLowerCase()}_${slug}`;
}

type OpenApiOp = {
  operationId: string;
  summary: string;
  tags: string[];
  'x-permission': string | null;
  responses: Record<string, unknown>;
  [k: string]: unknown;
};

const routes = extractRoutes();

// Preserve any existing hand-authored operation content, keyed by operationId.
const existing: Record<string, OpenApiOp> = {};
if (existsSync(SPEC_PATH)) {
  const prior = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as { paths?: Record<string, Record<string, OpenApiOp>> };
  for (const methods of Object.values(prior.paths ?? {})) {
    for (const op of Object.values(methods)) {
      if (op && typeof op === 'object' && 'operationId' in op) existing[op.operationId] = op;
    }
  }
}

const paths: Record<string, Record<string, OpenApiOp>> = {};
const tags = new Set<string>();
for (const r of routes) {
  const id = opId(r.method, r.path);
  const tag = tagFor(r.path);
  tags.add(tag);
  const prev = existing[id];
  const op: OpenApiOp = {
    operationId: id,
    summary: prev?.summary ?? `${r.method} ${r.path}`,
    tags: [tag],
    'x-permission': r.permission,
    responses: prev?.responses ?? {
      '200': { description: 'Success' },
      '403': { $ref: '#/components/responses/Forbidden' },
      '409': { $ref: '#/components/responses/Conflict' },
    },
    ...(prev?.description ? { description: prev.description } : {}),
    ...(prev?.requestBody ? { requestBody: prev.requestBody } : {}),
  };
  (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
}

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Sancta Clinic — Edge API',
    version: '0.1.0',
    description:
      'Offline-first clinic edge API (system of record). Every /api route is guarded by a deny-by-default permission (x-permission); the edge injects the authenticated user and roles at the session boundary. Contract enforced in CI by scripts/contract-check.ts.',
  },
  servers: [{ url: 'http://127.0.0.1:8791', description: 'Local edge hub' }],
  tags: [...tags].sort().map((t) => ({ name: t })),
  paths,
  components: {
    responses: {
      Forbidden: { description: 'Missing required permission (deny-by-default RBAC).' },
      Conflict: { description: 'Business-rule or state conflict (e.g. period closed, segregation, duplicate).' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
  },
};

writeFileSync(SPEC_PATH, JSON.stringify(spec, null, 2) + '\n');
console.log(`Wrote ${SPEC_PATH} — ${routes.length} operations across ${tags.size} tags.`);
