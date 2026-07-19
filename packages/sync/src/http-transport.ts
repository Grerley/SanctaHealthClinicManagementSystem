/**
 * HTTPS transport to the Cloudflare Worker sync ingress (SYN step 3, CLD-002).
 * Uses the platform `fetch` (Node 22 / Workers). The connection is TLS in
 * production; the URL points at the Worker route. Injectable `fetchImpl` for tests.
 */
import type { OutboxItem } from '@sancta/domain';
import type { SyncTransport, SyncReceipt } from './index.ts';

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class HttpSyncTransport implements SyncTransport {
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #deviceToken: string;

  constructor(ingressUrl: string, deviceToken: string, fetchImpl?: FetchLike) {
    this.#url = ingressUrl;
    this.#deviceToken = deviceToken;
    this.#fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async send(batch: { originSite: string; alreadySynced?: readonly string[]; items: readonly OutboxItem[] }): Promise<SyncReceipt> {
    const res = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Mutual device trust for edge sync (pack §16.1); TLS provides transport security.
        'authorization': `Device ${this.#deviceToken}`,
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      throw new Error(`sync ingress returned ${res.status}`);
    }
    const receipt = (await res.json()) as SyncReceipt;
    if (!receipt || receipt.durable !== true) {
      throw new Error('sync ingress did not return a durable receipt');
    }
    return receipt;
  }
}
