import { expect, type Page } from '@playwright/test';

/** The snapshot endpoint returns 503 while computing; wait until the engine is ready (or failed). */
export async function waitForSnapshot(page: Page) {
  await expect
    .poll(async () => (await (await page.request.get('/api/status')).json()).status, { timeout: 45_000 })
    .toMatch(/ready|error/);
  const status = await (await page.request.get('/api/status')).json();
  expect(status.error ?? null).toBeNull();
}

export async function selectYear(page: Page, year: number | string, name = 'Rok') {
  await page.getByRole('combobox', { name }).click();
  await page.getByRole('option', { name: String(year), exact: true }).click();
}

/** Collects page/console errors and non-local requests (guard rail 3). */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  const foreignRequests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol !== 'data:') foreignRequests.push(r.url());
  });
  return { errors, foreignRequests };
}
