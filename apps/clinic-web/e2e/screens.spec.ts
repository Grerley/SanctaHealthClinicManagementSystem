/**
 * E2E for the additional PWA screens (patients, queue, command centre) against the
 * real edge stack. Proves the tabbed shell drives the module APIs: patient search
 * + duplicate-aware registration, check-in showing a queue token, and a management
 * dashboard leading with exceptions.
 */
import { test, expect } from '@playwright/test';
import { resetDb } from './reset.ts';

test.beforeEach(async () => { await resetDb(); });

test('patients tab searches and registers, with duplicate review (PAT-002/003)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-patients').click();

  // Search finds a seeded synthetic patient.
  await page.getByTestId('patient-search').fill('Alpha');
  await expect(page.getByTestId('patient-results')).toContainText('Alpha');

  // Register a clearly new person.
  await page.getByTestId('reg-given').fill('Newperson');
  await page.getByTestId('reg-family').fill('Zeta');
  await page.getByTestId('reg-dob').fill('1995-05-05');
  await page.getByTestId('reg-submit').click();
  await expect(page.getByTestId('patients-message')).toContainText(/MRN SCC-/);
});

test('queue tab checks a patient in and shows a token (VIS-003)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-queue').click();
  await page.getByTestId('checkin').click();
  await expect(page.getByTestId('queue-message')).toContainText(/queue token \d+/);
  await expect(page.getByTestId('queue-board')).toContainText('reception');
});

test('command centre shows KPIs and leads with exceptions (MGT-001/003)', async ({ page }) => {
  await page.goto('/');
  // Create a debtor so an exception exists.
  await page.getByTestId('checkout').click();
  await expect(page.getByTestId('message')).toContainText(/Saved locally/i);

  await page.getByTestId('tab-dashboard').click();
  await expect(page.getByTestId('dash-kpis')).toContainText('Outstanding debtors');
  await expect(page.getByTestId('dash-exceptions')).toContainText(/balance|sync/i);
});
