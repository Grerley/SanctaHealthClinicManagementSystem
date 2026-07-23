/**
 * Accessibility gate (NFR-019, WCAG 2.2 AA). Runs axe-core against every tab of
 * the PWA on the real edge stack and fails the release on any serious/critical
 * violation. Low-resource clinics rely on assistive tech and low-vision defaults;
 * accessibility is a release gate, not a nicety. Runs in CI alongside the offline
 * E2E suite (same browser, same harness).
 */
import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { resetDb } from './reset.ts';

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TABS = [
  { testid: 'tab-dispense', name: 'Dispense & Pay' },
  { testid: 'tab-inbox', name: 'Inbox' },
  { testid: 'tab-patients', name: 'Patients' },
  { testid: 'tab-chart', name: 'Chart' },
  { testid: 'tab-queue', name: 'Queue' },
  { testid: 'tab-calendar', name: 'Calendar' },
  { testid: 'tab-inventory', name: 'Inventory' },
  { testid: 'tab-finance', name: 'Finance' },
  { testid: 'tab-dashboard', name: 'Command centre' },
];

test.beforeEach(async () => { await resetDb(); });

for (const tab of TABS) {
  test(`${tab.name} tab has no serious/critical WCAG 2.2 AA violations (NFR-019)`, async ({ page }) => {
    await page.goto('/');
    await page.getByTestId(tab.testid).click();
    // Let the tab's initial data load settle before scanning.
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
    const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    if (blocking.length > 0) {
      console.error(`\naxe violations on ${tab.name}:`);
      for (const v of blocking) console.error(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s)) — ${v.helpUrl}`);
    }
    expect(blocking, `serious/critical a11y violations on ${tab.name}`).toEqual([]);
  });
}
