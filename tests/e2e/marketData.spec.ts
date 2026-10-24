import { expect, test } from '@playwright/test';
import { trackErrors, waitForSnapshot } from './helpers';

// Synthetic fixtures use placeholder ISINs, so Yahoo Finance cannot resolve verified symbols for them.
test.describe('instruments without market data', () => {
  let saved: unknown;

  test.beforeEach(async ({ page }) => {
    await waitForSnapshot(page);
    const { settings } = await (await page.request.get('/api/settings')).json();
    saved = { symbolOverrides: settings.symbolOverrides };
  });

  test.afterEach(async ({ page }) => {
    await page.request.put('/api/settings', { data: saved });
    await waitForSnapshot(page);
  });

  test('overview, settings, portfolio and instrument page warn about missing market data', async ({ page }) => {
    const { errors, foreignRequests } = trackErrors(page);
    const snap = await (await page.request.get('/api/snapshot')).json();
    const missing = snap.instruments.filter((i: { hasMarket: boolean; type: string }) => !i.hasMarket && i.type !== 'CFD');
    test.skip(missing.length === 0, 'all synthetic instruments resolved');
    const held = snap.positions.find((p: { qty: number; instrumentId: string }) => p.qty > 1e-9 && missing.some((i: { id: string }) => i.id === p.instrumentId));

    await page.goto('/#/');
    const alert = page.locator('main').getByRole('alert').filter({ hasText: 'Instrumenty bez tržních dat' });
    await expect(alert).toContainText(String(missing.length));
    await expect(alert.getByRole('link', { name: 'Nastavení a data' })).toHaveAttribute('href', '#/nastaveni');
    if (held) await expect(alert.getByRole('link', { name: held.name })).toBeVisible();

    await page.goto('/#/nastaveni');
    const grid = page.locator('main').getByRole('table').last();
    await expect(page.locator('main')).toContainText(`Bez tržních dat: ${missing.length}`);
    // problems are sorted to the top
    await expect(grid.locator('tbody tr').first()).toContainText(/nenalezeno|ruční symbol bez dat/);

    if (held) {
      await page.goto('/#/portfolio');
      await expect(page.locator('main')).toContainText('≈');
      await page.goto(`/#/instrument/${encodeURIComponent(held.instrumentId)}`);
      await expect(page.locator('main').getByRole('alert').filter({ hasText: 'Chybí tržní data' })).toBeVisible();
    }
    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });

  test('a "-" override marks the instrument as deliberately disabled', async ({ page }) => {
    const snap = await (await page.request.get('/api/snapshot')).json();
    const missing = snap.instruments.filter((i: { hasMarket: boolean; type: string }) => !i.hasMarket && i.type !== 'CFD');
    test.skip(missing.length === 0, 'all synthetic instruments resolved');
    await page.request.put('/api/settings', { data: { symbolOverrides: { [missing[0].id]: '' } } });
    await waitForSnapshot(page);
    const after = await (await page.request.get('/api/snapshot')).json();
    expect(after.instruments.find((i: { id: string }) => i.id === missing[0].id).symbolSource).toBe('disabled');

    await page.goto('/#/nastaveni');
    await expect(page.locator('main').getByText('nepoužívat', { exact: true })).toBeVisible();
    if (missing.length === 1) await expect(page.locator('main')).not.toContainText('Bez tržních dat:');
    else await expect(page.locator('main')).toContainText(`Bez tržních dat: ${missing.length - 1}`);
  });
});
