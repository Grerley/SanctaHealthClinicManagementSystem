/**
 * Clinic edge hub HTTP server. Runs on the clinic LAN mini-PC and is the
 * operational system of record for launch-core work (ADR-0001). It serves the
 * PWA and the local API, commits to local PostgreSQL, and pushes queued changes
 * to the cloud when reachable — but never depends on the cloud (NFR-038).
 *
 * Env: DATABASE_URL (local PG), CLOUD_INGRESS_URL (optional), SITE_ID, EDGE_PORT,
 * WEB_DIST (path to built clinic-web assets).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import pg from 'pg';
import { listPatients, stockForSku, doCheckout, syncStatus, syncPush, type CheckoutApiBody } from './api.ts';

const PORT = Number(process.env['EDGE_PORT'] ?? 8787);
const SITE_ID = process.env['SITE_ID'] ?? '00000000-0000-7000-8000-0000000000f1';
const CLOUD_INGRESS_URL = process.env['CLOUD_INGRESS_URL'] ?? '';
const WEB_DIST = process.env['WEB_DIST'] ?? '';

const pool = process.env['DATABASE_URL'] ? new pg.Pool({ connectionString: process.env['DATABASE_URL'] }) : undefined;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  if (!WEB_DIST) {
    sendJson(res, 404, { error: { code: 'not_found' } });
    return;
  }
  // Prevent path traversal; default to index.html for the SPA shell.
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB_DIST, safe);
  try {
    const content = await readFile(file);
    const ext = extname(file);
    // Static shell is versioned; the app data it fetches is always no-store.
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    try {
      const shell = await readFile(join(WEB_DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] as string });
      res.end(shell);
    } catch {
      sendJson(res, 404, { error: { code: 'not_found' } });
    }
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const p = url.pathname;
    try {
      if (p === '/healthz') return sendJson(res, 200, { status: 'ok', plane: 'edge', offlineCapable: true });
      if (p === '/readyz') return sendJson(res, 200, { status: pool ? 'ready' : 'no-db' });

      if (p.startsWith('/api/')) {
        if (!pool) return sendJson(res, 503, { error: { code: 'no_database' } });
        if (p === '/api/patients' && req.method === 'GET') return sendJson(res, 200, { patients: await listPatients(pool) });
        if (p === '/api/stock' && req.method === 'GET') return sendJson(res, 200, await stockForSku(pool, url.searchParams.get('sku') ?? ''));
        if (p === '/api/checkout' && req.method === 'POST') {
          const body = (await readBody(req)) as CheckoutApiBody;
          const out = await doCheckout(pool, body);
          return sendJson(res, out.ok ? 201 : 409, out);
        }
        if (p === '/api/sync/status' && req.method === 'GET') return sendJson(res, 200, await syncStatus(pool));
        if (p === '/api/sync/push' && req.method === 'POST') {
          if (!CLOUD_INGRESS_URL) return sendJson(res, 200, { attempted: 0, acknowledged: 0, failed: 0, deferred: 0, note: 'no cloud configured' });
          return sendJson(res, 200, await syncPush(pool, CLOUD_INGRESS_URL, SITE_ID));
        }
        return sendJson(res, 404, { error: { code: 'not_found' } });
      }

      return await serveStatic(res, p);
    } catch (e) {
      const cid = 'edge-' + Date.now().toString(36);
      // Never leak internals or PHI (NFR-018/026).
      sendJson(res, 500, { error: { code: 'internal', correlationId: cid } });
    }
  })();
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`sancta clinic-edge on http://0.0.0.0:${PORT} (offline-capable; cloud=${CLOUD_INGRESS_URL || 'none'})`);
  });
}

export { server, pool };
