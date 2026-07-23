/**
 * Accessibility gate (NFR-019, WCAG 2.2 AA). Runs axe-core against EVERY tab of the
 * PWA on the real edge stack and fails the release on any serious/critical violation.
 * Low-resource clinics rely on assistive tech and low-vision defaults; accessibility
 * is a release gate, not a nicety.
 *
 * The tab list is discovered from the DOM at runtime (every `[data-testid^="tab-"]`
 * button), so a newly registered screen is covered automatically with no edit here —
 * the screen registry is the single source of truth. One test scans them all and
 * reports every failing tab in a single pass.
 */
import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { resetDb } from './reset.ts';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async () => { await resetDb(); });

test('every tab has no serious/critical WCAG 2.2 AA violations (NFR-019)', async ({ page }) => {
  test.setTimeout(600_000); // scans the whole catalogue of tabs in one run
  await page.goto('/');

  const testids = await page.locator('[data-testid^="tab-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid')).filter((v): v is string => !!v),
  );
  expect(testids.length, 'at least one tab is present').toBeGreaterThan(0);

  const failed: string[] = [];
  for (const testid of testids) {
    await page.getByTestId(testid).click();
    // Let the tab's initial data load settle before scanning.
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
    const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    if (blocking.length > 0) {
      failed.push(testid);
      console.error(`\naxe violations on ${testid}:`);
      for (const v of blocking) console.error(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s)) — ${v.helpUrl}`);
    }
  }

  expect(failed, `tabs with serious/critical a11y violations: ${failed.join(', ')}`).toEqual([]);
});
