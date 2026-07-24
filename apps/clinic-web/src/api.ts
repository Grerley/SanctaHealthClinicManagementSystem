/** Thin client for the LAN edge API. Same-origin; the edge is on the clinic LAN. */
import { sessionRoles, sessionUser } from './session.ts';

export type Patient = { id: string; mrn: string; given_name: string; family_name: string; dob: string; sex: string };

// A read that never returns (a hung LAN hub, a route that never responds) must not
// freeze the screen — availability is not the same as navigator.onLine (§10.2). We
// bound every read with an abort so a stalled request surfaces as "unreachable" and
// the caller can show its stale/error state instead of spinning forever.
const READ_TIMEOUT_MS = 10_000;

/** Exported so a screen can define its own typed reads inline (no central api edit),
 * keeping the read-timeout + session headers consistent across every module. */
export async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-roles': sessionRoles(), 'x-user': sessionUser(), ...(init?.headers ?? {}) },
    });
    if (!res.ok && res.status !== 409) throw new Error(`${url} -> ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
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
export type PendingResult = { orderId: string; patientId: string; mrn: string | null; name: string; category: string; code: string; priority: string; indication: string | null; orderedAt: string };
export type DueMedication = { requestId: string; patientId: string; mrn: string | null; name: string; medicineCode: string; substanceCode: string; dose: string | null; route: string | null; frequency: string | null; prescribedAt: string };
export type HandoverItem = { id: string; fromStaff: string | null; patientId: string | null; taskId: string | null; message: string; status: string; createdAt: string };
export type OpenReferral = { id: string; patientId: string; targetFacility: string; status: string };
export type DocSearchRow = { documentId: string; filename: string; version: number };
export type Device = { deviceId: string; label: string; site: string | null; trustState: string; softwareVersion: string | null; registeredAt: string; revokedAt: string | null };
export type PendingMessage = { messageId: string; patientId: string; channel: string; template: string };
export type CommsTask = { taskId: string; patientId: string | null; summary: string; inboundId: string };
export type CarePlan = {
  id: string; title: string; status: string;
  goals: Array<{ description: string; targetDate: string | null; status: string }>;
  followUps: Array<{ id: string; description: string; dueDate: string; status: string }>;
};
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
  pendingResults: () => jsonFetch<{ orders: PendingResult[] }>('/api/orders/pending-results'),
  dueMedications: () => jsonFetch<{ medications: DueMedication[] }>('/api/prescribe/due'),
  handoverInbox: (staffId: string) => jsonFetch<{ inbox: HandoverItem[] }>(`/api/handover/inbox?staffId=${encodeURIComponent(staffId)}`),
  openReferrals: () => jsonFetch<{ referrals: OpenReferral[] }>('/api/referrals/open'),
  searchDocuments: (term: string) => jsonFetch<{ documents: DocSearchRow[] }>(`/api/documents/search?term=${encodeURIComponent(term)}`),
  carePlans: (patientId: string) => jsonFetch<{ carePlans: CarePlan[] }>(`/api/ehr/care-plans?patientId=${encodeURIComponent(patientId)}`),
  devices: () => jsonFetch<{ devices: Device[] }>('/api/devices'),
  commsPending: () => jsonFetch<{ pending: PendingMessage[] }>('/api/comms/pending'),
  commsTasks: () => jsonFetch<{ tasks: CommsTask[] }>('/api/comms/tasks'),
  overdueTasks: (asOf?: string) => jsonFetch<{ tasks: OpsTask[] }>(`/api/ops/tasks/overdue${asOf ? `?asOf=${asOf}` : ''}`),
  stockAlerts: (asOf?: string) => jsonFetch<{ alerts: StockAlert[] }>(`/api/stock/alerts${asOf ? `?asOf=${asOf}` : ''}`),
  reorderSuggestions: () => jsonFetch<{ suggestions: ReorderSuggestion[] }>('/api/stock/reorder-suggestions'),
  openShifts: (cashier?: string) => jsonFetch<{ shifts: OpenShift[] }>(`/api/cashier/shifts${cashier ? `?cashier=${encodeURIComponent(cashier)}` : ''}`),
  encounter: (id: string) => jsonFetch<EncounterDetail>(`/api/encounters/get?id=${encodeURIComponent(id)}`),
};
