/** Thin client for the LAN edge API. Same-origin; the edge is on the clinic LAN. */
export type Patient = { id: string; mrn: string; given_name: string; family_name: string; dob: string; sex: string };

// In production these come from the authenticated, device-bound session. For the
// demo shell the operator holds front-desk + clinical + cashier + stock roles.
const SESSION_ROLES = 'reception,clinical,cashier,stock';
const SESSION_USER = 'demo-operator';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-roles': SESSION_ROLES, 'x-user': SESSION_USER, ...(init?.headers ?? {}) },
  });
  if (!res.ok && res.status !== 409) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  patients: () => jsonFetch<{ patients: Patient[] }>('/api/patients'),
  stock: (sku: string) => jsonFetch<{ sku: string; onHand: number }>(`/api/stock?sku=${encodeURIComponent(sku)}`),
  syncStatus: () => jsonFetch<{ pending: number }>('/api/sync/status'),
  checkout: (body: unknown) =>
    jsonFetch<{ ok: boolean; duplicate?: boolean; idempotencyKey?: string; invoiceId?: string; cogsMinor?: number }>(
      '/api/checkout',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  syncPush: () => jsonFetch<{ attempted: number; acknowledged: number; failed: number; deferred: number }>('/api/sync/push', { method: 'POST' }),
};
