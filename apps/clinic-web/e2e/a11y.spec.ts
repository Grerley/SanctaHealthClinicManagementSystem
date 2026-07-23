/**
 * Accessibility gate (NFR-019, WCAG 2.2 AA). Scans EVERY tab of the PWA on the real
 * edge stack and fails the release on any serious/critical violation. Low-resource
 * clinics rely on assistive tech and low-vision defaults; accessibility is a release
 * gate, not a nicety.
 *
 * The tab list is discovered from the DOM at runtime (every `[data-testid^="tab-"]`
 * button), so a newly registered screen is covered automatically with no edit here.
 *
 * Made to scale to the full catalogue on modest, occasionally I/O-starved CI runners:
 *  - the shell chrome (header, nav, patient banner) is scanned ONCE, full page;
 *  - each tab then scans ONLY the active screen subtree (`.shell__work` via include),
 *    so per-tab cost stays flat instead of re-scanning the whole (growing) shell;
 *  - the tabs are partitioned across several lanes that sweep concurrently, each on its
 *    own page — the sweep is read-only, so this needs no change to the global (serial)
 *    worker count that the DB-resetting specs depend on;
 *  - every step is bounded (a deep tab, a slow read, or a crashing screen fails that one
 *    tab in seconds and the lane recovers) so no single stall can consume the budget.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const LANES = 4; // concurrent pages within this single (serial) worker
const CLICK_MS = 6_000; // a tab must become reachable within this, or it counts as a failure
const SETTLE_MS = 1_500; // bounded settle after a tab switch — loading/stale states are accessible too

type Violation = { id: string; impact?: string | null; help: string; helpUrl: string; nodes: unknown[] };
const blocking = (vs: Violation[]): Violation[] => vs.filter((v) => v.impact === 'serious' || v.impact === 'critical');
const report = (where: string, vs: Violation[]): string =>
  [`\naxe violations on ${where}:`, ...vs.map((v) => `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s)) — ${v.helpUrl}`)].join('\n');

// Scan only the active screen subtree. include() limits axe's context to that subtree —
// far cheaper than scanning the whole document and excluding the nav after the fact.
async function scanWork(page: Page): Promise<Violation[]> {
  const res = await new AxeBuilder({ page }).include('.shell__work').withTags(WCAG_AA).analyze();
  return blocking(res.violations as Violation[]);
}

// Sweep one lane's slice of tabs on its own page. Every step is bounded and the shell is
// reloaded after any per-tab failure, so a single crashing or slow screen can never
// consume another tab's budget — or the whole run's.
async function sweepLane(page: Page, testids: string[], failed: string[]): Promise<void> {
  await page.goto('/');
  for (const testid of testids) {
    try {
      // Dispatched click is scroll-independent (a deep tab in a long grouped nav is not
      // reliably auto-scrolled into view); bounded so a missing/detached tab fails fast.
      await page.getByTestId(testid).dispatchEvent('click', {}, { timeout: CLICK_MS });
      await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
      const bad = await scanWork(page);
      if (bad.length > 0) {
        failed.push(testid);
        // eslint-disable-next-line no-console
        console.error(report(testid, bad));
      }
    } catch (err) {
      failed.push(testid);
      // eslint-disable-next-line no-console
      console.error(`\n${testid}: could not scan — ${(err as Error).message.split('\n')[0]}`);
      await page.goto('/').catch(() => {}); // recover the shell for the next tab in this lane
    }
  }
}

// No DB reset: this is a read-only render scan — screens render regardless of data, and
// the harness already seeds on startup — so we skip the expensive schema rebuild.
test('every tab has no serious/critical WCAG 2.2 AA violations (NFR-019)', async ({ page, browser }) => {
  test.setTimeout(300_000);
  await page.goto('/');

  const testids = await page.locator('[data-testid^="tab-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid')).filter((v): v is string => !!v),
  );
  expect(testids.length, 'at least one tab is present').toBeGreaterThan(0);

  // Shell chrome (header, nav, patient banner) — scanned once, full page.
  const shell = blocking((await new AxeBuilder({ page }).withTags(WCAG_AA).analyze()).violations as Violation[]);
  if (shell.length > 0) {
    // eslint-disable-next-line no-console
    console.error(report('the shell chrome', shell));
  }

  // Partition tabs round-robin across lanes and sweep them concurrently, each on its own
  // page. Round-robin spreads any clustered-cost screens evenly across lanes.
  const lanes: string[][] = Array.from({ length: LANES }, () => []);
  testids.forEach((id, i) => lanes[i % LANES]!.push(id));

  const failed: string[] = [];
  await Promise.all(
    lanes.map(async (slice) => {
      if (slice.length === 0) return;
      // A fresh context per lane (the test runner disallows browser.newPage()); baseURL
      // is inherited from the config, so relative goto('/') resolves to the edge harness.
      const context = await browser.newContext();
      try {
        await sweepLane(await context.newPage(), slice, failed);
      } finally {
        await context.close();
      }
    }),
  );

  const sortedFailed = [...failed].sort();
  expect(shell, 'serious/critical a11y violations on the shell chrome').toEqual([]);
  expect(sortedFailed, `tabs with serious/critical a11y violations (or unscannable): ${sortedFailed.join(', ')}`).toEqual([]);
});
