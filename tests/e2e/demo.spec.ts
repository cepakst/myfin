import { expect, test, type Page } from '@playwright/test';
import { trackErrors, waitForSnapshot } from './helpers';

// The demo data use ~15 real instruments, so the first computation downloads their price history.
const DEMO_TIMEOUT = 150_000;

async function snapshotDemo(page: Page): Promise<boolean> {
  await waitForSnapshot(page, DEMO_TIMEOUT);
  return (await (await page.request.get('/api/snapshot')).json()).demo;
}

test.describe('demo data', () => {
  test.setTimeout(4 * 60_000);

  test.beforeEach(async ({ page }) => {
    await waitForSnapshot(page);
  });

  test.afterEach(async ({ page }) => {
    await page.request.put('/api/demo', { data: { enabled: false } });
    await waitForSnapshot(page, DEMO_TIMEOUT);
  });

  test('switching to demo data shows the DEMO badge and the demo portfolio, switching back restores own exports', async ({ page }) => {
    const { errors, foreignRequests } = trackErrors(page);
    await page.goto('/#/nastaveni');
    const header = page.locator('header');
    await expect(header.getByText('My finance')).toBeVisible();
    await expect(header.getByTestId('demo-badge')).toHaveCount(0);

    await page.locator('main').getByText('Demo data', { exact: true }).click();
    await expect.poll(() => snapshotDemo(page), { timeout: DEMO_TIMEOUT }).toBe(true);
    await expect(header.getByTestId('demo-badge')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('main').getByRole('alert').filter({ hasText: 'Zobrazena demo data' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Složka s exporty' })).toBeDisabled();

    await page.goto('/#/portfolio');
    await expect(page.locator('main')).toContainText('NVIDIA', { timeout: 15_000 });
    await expect(page.locator('main')).toContainText('CEZ');
    await expect(header.getByTestId('demo-badge')).toBeVisible();

    // the badge leads to the data source switch
    await header.getByTestId('demo-badge').click();
    await expect(page).toHaveURL(/#\/nastaveni$/);
    await page.locator('main').getByText('Moje exporty', { exact: true }).click();
    await expect.poll(() => snapshotDemo(page), { timeout: DEMO_TIMEOUT }).toBe(false);
    await expect(header.getByTestId('demo-badge')).toHaveCount(0, { timeout: 15_000 });
    await page.goto('/#/portfolio');
    await expect(page.locator('main')).not.toContainText('NVIDIA');

    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });

  test('demo mode keeps its own settings', async ({ page }) => {
    const real = (await (await page.request.get('/api/settings')).json()).settings;
    await page.request.put('/api/demo', { data: { enabled: true } });
    const demoBefore = await (await page.request.get('/api/settings')).json();
    expect(demoBefore.demo).toBe(true);

    const other = real.defaultSituation === 'EMPLOYEE' ? 'NO_INCOME' : 'EMPLOYEE';
    await page.request.put('/api/settings', { data: { defaultSituation: other, exportsDir: 'C:/should/be/ignored', demo: false } });
    const demoAfter = await (await page.request.get('/api/settings')).json();
    expect(demoAfter.demo).toBe(true);
    expect(demoAfter.settings.defaultSituation).toBe(other);
    expect(demoAfter.settings.exportsDir).toBeUndefined();

    await page.request.put('/api/settings', { data: { defaultSituation: demoBefore.settings.defaultSituation } });
    await page.request.put('/api/demo', { data: { enabled: false } });
    const back = await (await page.request.get('/api/settings')).json();
    expect(back.demo).toBe(false);
    expect(back.settings.defaultSituation).toBe(real.defaultSituation);
    expect(back.settings.exportsDir).toBe(real.exportsDir);
  });
});
