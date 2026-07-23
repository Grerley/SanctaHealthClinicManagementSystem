/**
 * Accessibility gate (NFR-019, WCAG 2.2 AA). Scans EVERY tab of the PWA on the real
 * edge stack and fails the release on any serious/critical violation. Low-resource
 * clinics rely on assistive tech and low-vision defaults; accessibility is a release
 * gate, not a nicety.
 *
 * The tab list is discovered from the DOM at runtime (every `[data-testid^="tab-"]`
 * button), so a newly registered screen is covered automatically with no edit here.
 *
 * Cost control (so the sweep scales to the full catalogue on modest CI runners):
 *  - the shell chrome (header, nav, patient banner) is scanned ONCE, full-page;
 *  - each tab then scans ONLY the active screen subtree (`.shell__work`), so per-tab
 *    cost stays flat instead of re-scanning the whole (growing) nav every time;
 *  - tabs are switched via a dispatched click (scroll-independent) and the settle
 *    wait is bounded, so a deep tab or a slow read can't stall the run.
 */
import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const blocking = (vs: { impact?: string | null }[]) => vs.filter((v) => v.impact === 'serious' || v.impact === 'critical');

// No DB reset: this is a read-only render scan — screens render regardless of data,
// and the harness already seeds on startup — so we skip the expensive schema rebuild.
test('every tab has no serious/critical WCAG 2.2 AA violations (NFR-019)', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/');

  const testids = await page.locator('[data-testid^="tab-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid')).filter((v): v is string => !!v),
  );
  expect(testids.length, 'at least one tab is present').toBeGreaterThan(0);

  // Shell chrome (header, nav, patient banner) — scanned once, full page.
  const shell = blocking((await new AxeBuilder({ page }).withTags(WCAG_AA).analyze()).violations);
  if (shell.length > 0) {
    console.error('\naxe violations on the shell chrome:');
    for (const v of shell) console.error(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s)) — ${v.helpUrl}`);
  }

  const failed: string[] = [];
  for (const testid of testids) {
    // Dispatched click is scroll-independent (a deep tab in a long grouped nav is not
    // reliably auto-scrolled into view); the tab is a plain button whose React onClick
    // fires on a dispatched click regardless of position.
    await page.getByTestId(testid).dispatchEvent('click');
    // Bound the settle wait: a slow/hung read must not consume the budget. axe still
    // scans what rendered — loading/stale StateBlocks are accessible.
    await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {});

    // Scan ONLY the active screen — keeps per-tab cost flat as the nav grows.
    const results = await new AxeBuilder({ page }).include('.shell__work').withTags(WCAG_AA).analyze();
    const bad = blocking(results.violations);
    if (bad.length > 0) {
      failed.push(testid);
      console.error(`\naxe violations on ${testid}:`);
      for (const v of bad) console.error(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s)) — ${v.helpUrl}`);
    }
  }

  expect(shell, 'serious/critical a11y violations on the shell chrome').toEqual([]);
  expect(failed, `tabs with serious/critical a11y violations: ${failed.join(', ')}`).toEqual([]);
});
