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

export type QueueRow = { visitId: string; token: number; station: string; priority: number; status: string; patientMrn: string | null };
export type CalendarEntry = { slotId: string; provider: string; room: string | null; serviceCode: string | null; startsAt: string; endsAt: string; day: string; status: string; patientMrn: string | null };
export type Kpi = { id: string; label: string; value: number; unit: string; owner: string; formula: string };
export type Exception = { type: string; label: string; count: number; queue: string; owner: string };
export type TimelineItem = { type: 'encounter' | 'addendum' | 'observation' | 'result'; id: string; at: string; summary: string; author: string | null; status?: string; flags?: string[] };
export type HistoryItem = { id: string; category: string; detail: string; code: string | null; status: string; onsetDate: string | null };
export type AgeingBand = '0-30' | '31-60' | '61-90' | '90+';
export type DebtorRow = { patientId: string; mrn: string | null; name: string; outstandingMinor: number; oldestBand: AgeingBand };
export type AgeingReport = { asOf: string; buckets: Record<AgeingBand, number>; totalMinor: number; arControlMinor: number; reconciles: boolean; workQueue: DebtorRow[] };
export type TrialBalanceRow = { code: string; name: string; type: string; debitMinor: number; creditMinor: number; netMinor: number };
export type TrialBalance = { rows: TrialBalanceRow[]; totalDebitMinor: number; totalCreditMinor: number; balanced: boolean };

export type EncounterNote = { subjective?: string; objective?: string; assessment?: string; plan?: string };
export type EncounterAddendum = { author: string; content: unknown; createdAt: string };
export type EncounterDetail = { status: string; content: unknown; signedBy: string | null; addenda: EncounterAddendum[] };
export type OpenShift = { shiftId: string; cashier: string; site: string | null; openedAt: string; openingFloatMinor: number; cashReceiptsMinor: number; paymentCount: number; expectedMinor: number };
export type CloseShiftResult = { shiftId: string; expectedMinor: number; countedMinor: number; varianceMinor: number; requiresApproval: boolean; approved: boolean; status: 'closed' };
export type CriticalResult = { resultId: string; patientId: string; value: number; abnormal: string; releasedAt: string };
export type OpsTask = { taskId: string; subject: string; owner: string | null; priority: number; dueDate: string };
export type StockAlert = { sku: string; name: string; onHand: number; reorderMin: number | null; flags: string[] };
export type ReorderSuggestion = { sku: string; suggest: boolean; suggestedQty: number; coverDays: number | null; assumptions: { reorderMin: number | null; reorderMax: number | null; avgDailyUse: number | null } };

/** Format minor currency units (cents) as a plain amount with tabular grouping. */
export function money(minor: number): string {
  return (minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const api = {
  patients: () => jsonFetch<{ patients: Patient[] }>('/api/patients'),
  searchPatients: (q: string) => jsonFetch<{ patients: Patient[] }>(`/api/patients?q=${encodeURIComponent(q)}`),
  registerPatient: (body: unknown) =>
    jsonFetch<{ ok: boolean; id?: string; mrn?: string; duplicates?: Array<{ candidate: Patient; score: number; reasons: string[] }> }>(
      '/api/patients',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  stock: (sku: string) => jsonFetch<{ sku: string; onHand: number }>(`/api/stock?sku=${encodeURIComponent(sku)}`),
  syncStatus: () => jsonFetch<{ pending: number }>('/api/sync/status'),
  checkout: (body: unknown) =>
    jsonFetch<{ ok: boolean; duplicate?: boolean; idempotencyKey?: string; invoiceId?: string; cogsMinor?: number }>(
      '/api/checkout',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  syncPush: () => jsonFetch<{ attempted: number; acknowledged: number; failed: number; deferred: number }>('/api/sync/push', { method: 'POST' }),
  startVisit: (patientId: string, station: string) =>
    jsonFetch<{ visitId: string; token: number }>('/api/visits/start', { method: 'POST', body: JSON.stringify({ patientId, station }) }),
  queue: (station?: string) => jsonFetch<{ queue: QueueRow[] }>(`/api/visits/queue${station ? `?station=${encodeURIComponent(station)}` : ''}`),
  dashboard: () => jsonFetch<{ asOf: string; kpis: Kpi[]; exceptions: Exception[] }>('/api/management/dashboard'),
  calendar: (from: string, to: string) => jsonFetch<{ entries: CalendarEntry[] }>(`/api/schedule/calendar?from=${from}&to=${to}`),
  createSlot: (body: { provider: string; startsAt: string; endsAt: string; room?: string; serviceCode?: string }) =>
    jsonFetch<{ slotId: string }>('/api/schedule/slot', { method: 'POST', body: JSON.stringify(body) }),
  timeline: (patientId: string, type?: string) =>
    jsonFetch<{ timeline: TimelineItem[] }>(`/api/timeline?patientId=${encodeURIComponent(patientId)}${type ? `&type=${encodeURIComponent(type)}` : ''}`),
  ehrHistory: (patientId: string) =>
    jsonFetch<{ history: HistoryItem[] }>(`/api/ehr/history?patientId=${encodeURIComponent(patientId)}`),
  debtorsAgeing: (asOf?: string) =>
    jsonFetch<AgeingReport>(`/api/debtors/ageing${asOf ? `?asOf=${asOf}` : ''}`),
  trialBalance: () => jsonFetch<TrialBalance>('/api/finance/trial-balance'),
  criticalResults: () => jsonFetch<{ results: CriticalResult[] }>('/api/orders/critical/outstanding'),
  overdueTasks: (asOf?: string) => jsonFetch<{ tasks: OpsTask[] }>(`/api/ops/tasks/overdue${asOf ? `?asOf=${asOf}` : ''}`),
  stockAlerts: (asOf?: string) => jsonFetch<{ alerts: StockAlert[] }>(`/api/stock/alerts${asOf ? `?asOf=${asOf}` : ''}`),
  reorderSuggestions: () => jsonFetch<{ suggestions: ReorderSuggestion[] }>('/api/stock/reorder-suggestions'),
  openShifts: (cashier?: string) => jsonFetch<{ shifts: OpenShift[] }>(`/api/cashier/shifts${cashier ? `?cashier=${encodeURIComponent(cashier)}` : ''}`),
  encounter: (id: string) => jsonFetch<EncounterDetail>(`/api/encounters/get?id=${encodeURIComponent(id)}`),
};
