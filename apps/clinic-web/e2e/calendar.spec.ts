/**
 * Calendar views E2E + performance (APT-008) against the real edge stack. Seeds a
 * week of slots across providers, rooms and services, then proves the calendar
 * renders day and week views, regroups by provider/room/service, and loads within
 * the 2-second budget.
 */
import { test, expect } from '@playwright/test';
import { resetDb } from './reset.ts';
import { presetPersona } from './session-preset.ts';

const HEADERS = { 'x-roles': 'reception,clinical,cashier,stock', 'x-user': 'demo-operator', 'content-type': 'application/json' };
const PROVIDERS = ['00000000-0000-7000-8000-0000000000d1', '00000000-0000-7000-8000-0000000000d2'];
const ROOMS = ['Room 1', 'Room 2'];
const SERVICES = ['GP', 'DENTAL'];

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test.beforeEach(async ({ page }) => { await resetDb(); await presetPersona(page); });

test('calendar renders day/week views, regroups, and loads within 2s (APT-008)', async ({ page, request }) => {
  const today = new Date().toISOString().slice(0, 10);

  // Seed 42 slots across the week (6 per day), spread over providers/rooms/services.
  const posts = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(today, i % 7);
    const hour = String(8 + (i % 6)).padStart(2, '0');
    posts.push(
      request.post('/api/schedule/slot', {
        headers: HEADERS,
        data: {
          provider: PROVIDERS[i % 2],
          room: ROOMS[i % 2],
          serviceCode: SERVICES[i % 2],
          startsAt: `${day}T${hour}:00:00Z`,
          endsAt: `${day}T${hour}:30:00Z`,
        },
      }),
    );
  }
  const results = await Promise.all(posts);
  for (const r of results) expect(r.ok()).toBeTruthy();

  await page.goto('/');

  // --- Performance: opening the calendar and rendering the day view is < 2s.
  const start = Date.now();
  await page.getByTestId('tab-calendar').click();
  await expect(page.getByTestId('calendar-slot').first()).toBeVisible();
  const elapsedMs = Date.now() - start;
  expect(elapsedMs, `calendar day view rendered in ${elapsedMs}ms`).toBeLessThan(2000);

  // Day view shows today's slots grouped by provider (default).
  await expect(page.getByTestId('calendar-status')).toContainText('day of');
  await expect(page.getByTestId(`calendar-day-${today}`)).toBeVisible();

  // Week view shows seven day columns.
  await page.getByTestId('view-week').click();
  await expect(page.getByTestId(`calendar-day-${today}`)).toBeVisible();
  await expect(page.getByTestId(`calendar-day-${addDays(today, 6)}`)).toBeVisible();
  await expect(page.getByTestId('calendar-status')).toContainText('week of');

  // Regroup by room, then by service — the grouping headers reflect the dimension.
  await page.getByTestId('group-room').click();
  await expect(page.getByTestId('calendar-grid')).toContainText('Room 1');
  await page.getByTestId('group-service').click();
  await expect(page.getByTestId('calendar-grid')).toContainText('GP');

  // Provider grouping shows the seeded provider ids.
  await page.getByTestId('group-provider').click();
  await expect(page.getByTestId('calendar-grid')).toContainText(PROVIDERS[0]!.slice(0, 8));
});
