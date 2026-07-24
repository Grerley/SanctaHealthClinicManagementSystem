/**
 * Vertical-slice E2E (UAT-01 UI dimension). Drives the real PWA against the real
 * edge hub + cloud store and proves:
 *  - the app shell renders offline from the service-worker cache (SYN-001);
 *  - a dispense-and-pay commits locally and shows a pending-sync state (SYN-002/005);
 *  - stock decrements locally;
 *  - "Sync now" reconciles the change to the cloud (SYN-004) with no duplication.
 */
import { test, expect } from '@playwright/test';
import { resetDb } from './reset.ts';
import { presetPersona } from './session-preset.ts';

test.beforeEach(async ({ page }) => { await resetDb(); await presetPersona(page); });
import pg from 'pg';

const CLOUD_DATABASE_URL = process.env['CLOUD_DATABASE_URL'] ?? 'postgres://sancta@127.0.0.1:5433/sancta_cloud';

async function cloudCheckoutCount(): Promise<number> {
  const c = new pg.Client({ connectionString: CLOUD_DATABASE_URL });
  await c.connect();
  try {
    const r = await c.query(`SELECT count(*)::int AS n FROM cloud.synced_checkout`);
    return r.rows[0].n as number;
  } finally {
    await c.end();
  }
}

test('app shell loads and shows initial stock and synced state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Sancta Clinic/i })).toBeVisible();
  await expect(page.getByTestId('stock')).toContainText('1500');
  await expect(page.getByTestId('sync-badge')).toContainText('All synced');
});

test('the application shell renders offline from the service-worker cache (SYN-001)', async ({ page, context }) => {
  await page.goto('/');
  // Wait for the service worker to become active, then reload once online so the
  // now-controlling SW caches the shell + hashed assets via its fetch handler.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForTimeout(300);

  await context.setOffline(true);
  await page.reload();
  // The shell still renders even though the network is down.
  await expect(page.getByRole('heading', { name: /Sancta Clinic/i })).toBeVisible();
  await expect(page.getByTestId('net-status')).toContainText(/Offline/i);
  await context.setOffline(false);
});

test('dispense-and-pay commits locally, then syncs and reconciles to the cloud (UAT-01)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('stock')).toContainText('1500');
  expect(await cloudCheckoutCount()).toBe(0);

  // Perform the checkout (quantity 10).
  await page.getByTestId('qty').fill('10');
  await page.getByTestId('checkout').click();

  // Saved locally, receipt issued, queued for sync — WITHOUT touching the cloud.
  await expect(page.getByTestId('message')).toContainText(/Saved locally/i);
  await expect(page.getByTestId('sync-badge')).toContainText('Pending sync: 1');
  await expect(page.getByTestId('stock')).toContainText('1490'); // 1500 - 10
  expect(await cloudCheckoutCount()).toBe(0); // still nothing centrally

  // Reconnect / sync: push to the cloud and reconcile.
  await page.getByTestId('sync').click();
  await expect(page.getByTestId('message')).toContainText(/Synchronised 1/i);
  await expect(page.getByTestId('sync-badge')).toContainText('All synced');
  expect(await cloudCheckoutCount()).toBe(1); // reconciled centrally, no duplication
});
