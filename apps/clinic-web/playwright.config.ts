import { defineConfig, devices } from '@playwright/test';

const EDGE_PORT = process.env['EDGE_PORT'] ?? '8791';
const BASE_URL = `http://127.0.0.1:${EDGE_PORT}`;

// Use a pre-installed Chromium when PW_CHROMIUM points at one (this environment);
// otherwise fall back to Playwright's own managed browser (CI runs
// `playwright install chromium`).
const CHROMIUM = process.env['PW_CHROMIUM'];

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    ...(CHROMIUM ? { launchOptions: { executablePath: CHROMIUM } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --experimental-strip-types ./e2e/harness.ts',
    url: `${BASE_URL}/healthz`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://sancta@127.0.0.1:5433/sancta_test',
      CLOUD_DATABASE_URL: process.env['CLOUD_DATABASE_URL'] ?? 'postgres://sancta@127.0.0.1:5433/sancta_cloud',
      EDGE_PORT,
    },
  },
});
