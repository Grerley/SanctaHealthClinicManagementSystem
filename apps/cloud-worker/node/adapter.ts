/**
 * Node cloud adapter (dev/test only). Runs the durable CloudSyncService behind an
 * HTTP endpoint over a real cloud PostgreSQL, so the edge sync engine can be
 * exercised end-to-end against a genuine central store. In production the same
 * CloudSyncService runs inside the Cloudflare Worker (see src/index.ts) over a
 * cache-disabled Hyperdrive binding — this adapter is the local stand-in.
 */
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import { CloudSyncService } from '../src/cloud-sync.ts';
import { PgCloudStore, CLOUD_SCHEMA_SQL } from './pg-cloud-store.ts';

export type CloudAdapter = { server: Server; pool: pg.Pool; url: string };

export async function startCloudAdapter(connectionString: string, port = 0): Promise<CloudAdapter> {
  const pool = new pg.Pool({ connectionString });
  await pool.query(CLOUD_SCHEMA_SQL);
  const service = new CloudSyncService(new PgCloudStore(pool));

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/sync/ingress') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const receipt = await service.apply(JSON.parse(body));
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(receipt));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: { code: 'sync_ingress_invalid' } }));
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found' } }));
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  return { server, pool, url: `http://127.0.0.1:${boundPort}/sync/ingress` };
}

export async function stopCloudAdapter(a: CloudAdapter): Promise<void> {
  await new Promise<void>((resolve) => a.server.close(() => resolve()));
  await a.pool.end();
}
