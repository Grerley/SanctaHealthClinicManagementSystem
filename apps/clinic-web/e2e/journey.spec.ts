/**
 * Broad end-to-end patient journey against the real offline-first stack. One
 * synthetic patient travels the whole front-of-house flow through the PWA:
 * register → select (persistent banner) → check in (queue token) → an appointment
 * booked and shown on the calendar → dispense & take part-payment → sync to the
 * cloud → the resulting debtor surfaces on the command centre. This exercises the
 * modules together, not in isolation, so regressions in the seams are caught.
 */
import { test, expect } from '@playwright/test';
import { resetDb } from './reset.ts';
import { presetPersona } from './session-preset.ts';

const HEADERS = { 'x-roles': 'reception,clinical,cashier,stock', 'x-user': 'demo-operator', 'content-type': 'application/json' };
const PROVIDER = '00000000-0000-7000-8000-0000000000d1';

test.beforeEach(async ({ page }) => { await resetDb(); await presetPersona(page); });

test('a patient travels register → queue → calendar → dispense → sync → command centre', async ({ page, request }) => {
  const today = new Date().toISOString().slice(0, 10);
  await page.goto('/');

  // 1. Register a new synthetic patient.
  await page.getByTestId('tab-patients').click();
  await page.getByTestId('reg-given').fill('Journey');
  await page.getByTestId('reg-family').fill('Traveller');
  await page.getByTestId('reg-dob').fill('1992-03-14');
  await page.getByTestId('reg-submit').click();
  await expect(page.getByTestId('patients-message')).toContainText(/MRN SCC-/);

  // 2. Find them and select — the banner persists across tabs.
  await page.getByTestId('patient-search').fill('Traveller');
  await expect(page.getByTestId('patient-results')).toContainText('Traveller');
  await page.getByTestId('patient-select').first().click();
  await expect(page.getByTestId('banner-name')).toContainText('Traveller');

  // Read back the MRN so we can seed an appointment for exactly this patient.
  const found = await request.get('/api/patients?q=Traveller', { headers: HEADERS });
  const patient = (await found.json()).patients.find((p: { family_name: string }) => p.family_name === 'Traveller');
  expect(patient).toBeTruthy();

  // 3. Check in — a queue token is issued.
  await page.getByTestId('tab-queue').click();
  await page.getByTestId('checkin').click();
  await expect(page.getByTestId('queue-message')).toContainText(/queue token \d+/);
  await expect(page.getByTestId('banner-name')).toContainText('Traveller'); // banner still there

  // 4. Book an appointment (via API) and see it on the calendar with the patient MRN.
  const slot = await request.post('/api/schedule/slot', {
    headers: HEADERS,
    data: { provider: PROVIDER, room: 'Room 1', serviceCode: 'GP', startsAt: `${today}T11:00:00Z`, endsAt: `${today}T11:30:00Z` },
  });
  const { slotId } = await slot.json();
  const book = await request.post('/api/schedule/book', { headers: HEADERS, data: { slotId, patientId: patient.id, serviceCode: 'GP' } });
  expect((await book.json()).ok).toBeTruthy();

  await page.getByTestId('tab-calendar').click();
  await expect(page.getByTestId('calendar-grid')).toContainText(patient.mrn);
  await expect(page.getByTestId('calendar-grid')).toContainText('booked');

  // 5. Dispense & take a part-payment — a receipt is issued and a change is queued.
  await page.getByTestId('tab-dispense').click();
  // Select our patient in the dispense dropdown by its visible label (MRN).
  await page.getByTestId('patient').selectOption({ label: `Traveller, Journey (${patient.mrn})` });
  await page.getByTestId('qty').fill('5');
  await page.getByTestId('charge').fill('1500');
  await page.getByTestId('payment').fill('500'); // part payment → a debtor balance
  await page.getByTestId('checkout').click();
  await expect(page.getByTestId('message')).toContainText(/Saved locally/i);
  await expect(page.getByTestId('sync-badge')).toContainText(/Pending sync/);

  // 6. Sync to the cloud.
  await page.getByTestId('sync').click();
  await expect(page.getByTestId('message')).toContainText(/Synchronised \d+ change/);

  // 7. The command centre leads with the debtor exception created by the part-payment.
  await page.getByTestId('tab-dashboard').click();
  await expect(page.getByTestId('dash-kpis')).toContainText('Outstanding debtors');
  await expect(page.getByTestId('dash-exceptions')).toContainText(/balance|debtor/i);
});
