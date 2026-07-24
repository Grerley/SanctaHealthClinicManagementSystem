import type { Page, BrowserContext } from '@playwright/test';

/**
 * The shell now gates the workspace behind a persona sign-in. For E2E we preset the
 * Administrator persona (full access to every module) before the app boots, so specs
 * land straight in the workspace with all tabs present — exactly as before the sign-in
 * screen existed. addInitScript runs on every navigation (incl. reloads).
 */
const INIT = (): void => {
  try {
    window.localStorage.setItem('sancta.persona', 'administrator');
  } catch {
    /* storage disabled — the app falls back to its default roles */
  }
};

export async function presetPersona(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(INIT);
}
