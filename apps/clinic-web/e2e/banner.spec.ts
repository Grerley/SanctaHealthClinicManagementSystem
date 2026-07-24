/**
 * Persistent patient banner + stale-offline indicator (EHR-001). Selecting a
 * patient shows a banner that persists across tabs; going offline surfaces a
 * "record may be stale" warning; coming back online clears it.
 */
import { test, expect } from '@playwright/test';
import { resetDb } from './reset.ts';
import { presetPersona } from './session-preset.ts';

test.beforeEach(async ({ page }) => { await resetDb(); await presetPersona(page); });

test('a selected patient banner persists across tabs and warns when offline (EHR-001)', async ({ page, context }) => {
  await page.goto('/');
  await page.getByTestId('tab-patients').click();

  // Find and select a seeded patient.
  await page.getByTestId('patient-search').fill('Alpha');
  await expect(page.getByTestId('patient-results')).toContainText('Alpha');
  await page.getByTestId('patient-select').first().click();

  // The banner shows the patient and persists when switching tabs.
  const banner = page.getByTestId('patient-banner');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('banner-name')).toContainText('Alpha');
  await page.getByTestId('tab-queue').click();
  await expect(banner).toBeVisible(); // still there on another tab
  await expect(page.getByTestId('stale-indicator')).toHaveCount(0); // online: no stale warning

  // Going offline surfaces the stale indicator; coming back online clears it.
  await context.setOffline(true);
  await expect(page.getByTestId('stale-indicator')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId('stale-indicator')).toHaveCount(0);
});
