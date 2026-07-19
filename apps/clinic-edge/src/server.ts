/**
 * Clinic edge hub HTTP server (skeleton). Runs on the clinic LAN mini-PC and is
 * the operational system of record for launch-core work (ADR-0001). It keeps
 * serving devices, saving transactions and queuing sync with NO internet.
 *
 * Phase-1 skeleton: health + readiness only. Local API routes, the local
 * PostgreSQL transaction boundary (wrapping planDispense et al.), print/backup
 * agents and offline auth land with the vertical slice.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env['EDGE_PORT'] ?? 8787);

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Edge responses carry protected data — never cache (mirrors CLD-011).
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/healthz') {
    json(res, 200, { status: 'ok', plane: 'edge', offlineCapable: true });
    return;
  }
  if (url.pathname === '/readyz') {
    // In production: check local PostgreSQL, outbox writer, print queue, backup agent.
    json(res, 200, { status: 'ready', checks: { db: 'pending', outbox: 'pending', print: 'pending' } });
    return;
  }
  json(res, 404, { error: { code: 'not_found' } });
});

// Only start listening when run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`sancta clinic-edge listening on http://0.0.0.0:${PORT} (offline-capable)`);
  });
}

export { server };
