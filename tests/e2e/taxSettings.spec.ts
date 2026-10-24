import { expect, test } from '@playwright/test';
import { selectYear, trackErrors, waitForSnapshot } from './helpers';

test.describe('tax settings on the Taxes page', () => {
  let saved: unknown;

  test.beforeEach(async ({ page }) => {
    await waitForSnapshot(page);
    const { settings } = await (await page.request.get('/api/settings')).json();
    saved = { taxProfiles: settings.taxProfiles, fx: settings.fx };
  });

  test.afterEach(async ({ page }) => {
    await page.request.put('/api/settings', { data: saved });
    await waitForSnapshot(page);
  });

  test('switching dividend taxation and FX method recomputes the comparison', async ({ page }) => {
    const { errors, foreignRequests } = trackErrors(page);
    await page.goto('/#/dane');
    await selectYear(page, 2024);
    const main = page.locator('main');
    const table = main.getByRole('table', { name: 'Porovnání variant' });
    await expect(table.locator('tbody tr')).toHaveCount(4);
    await expect(main.getByText('nejvýhodnější').first()).toBeVisible();

    const current = table.locator('tbody tr', { has: page.getByText('zvoleno', { exact: true }) });
    await expect(current).toHaveCount(1);
    await expect(current).toContainText('jednotný kurz');
    await expect(current).toContainText('§16a');

    await main.getByRole('radiogroup', { name: 'Zdanění zahraničních dividend' }).getByText('Obecný základ', { exact: true }).click();
    await expect(current).toContainText('obecný základ', { timeout: 45_000 });
    await expect(main.getByRole('heading', { name: 'Dividendy a kapitálové příjmy (§8)' })).toBeVisible();
    await expect(main).toContainText('Příloha č. 3');

    await main.getByRole('radiogroup', { name: 'Přepočet měn' }).getByText('Denní ČNB', { exact: true }).click();
    await expect(current).toContainText('denní kurz ČNB', { timeout: 45_000 });

    // "Použít" applies both choices of a row at once
    const unified16a = table.locator('tbody tr', { hasText: 'jednotný kurz' }).filter({ hasText: '§16a' });
    await unified16a.getByRole('button', { name: 'Použít' }).click();
    await expect(unified16a).toContainText('zvoleno', { timeout: 45_000 });

    const { settings } = await (await page.request.get('/api/settings')).json();
    expect(settings.fx.methodByYear['2024'] ?? 'UNIFIED').toBe('UNIFIED');
    expect(settings.taxProfiles['2024'].foreign16a).toBe(true);
    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });

  test('selected scenario matches the main computation when FX methods differ between years', async ({ page }) => {
    await page.request.put('/api/settings', { data: { fx: { methodByYear: { 2020: 'DAILY', 2023: 'DAILY' }, unifiedOverrides: {} } } });
    await waitForSnapshot(page);
    const snap = await (await page.request.get('/api/snapshot')).json();
    const checked: number[] = [];
    for (const sum of snap.taxSummaries) {
      const method = snap.fxYears.find((f: { year: number }) => f.year === sum.year).method;
      const selected = snap.taxScenarios[sum.year].find((x: { fxMethod: string; use16a: boolean }) => x.fxMethod === method && x.use16a === sum.use16a);
      expect(selected, `year ${sum.year}`).toBeTruthy();
      expect(selected.estimatedTaxTotalCzk, `year ${sum.year}`).toBeCloseTo(sum.estimatedTaxTotalCzk, 2);
      expect(selected.securitiesBaseCzk, `year ${sum.year}`).toBeCloseTo(snap.securities.find((r: { year: number }) => r.year === sum.year).taxable.baseCzk, 2);
      checked.push(sum.year);
    }
    expect(checked).toContain(2024);
  });

  test('situation can be changed per year', async ({ page }) => {
    await page.goto('/#/dane');
    await selectYear(page, 2024);
    const main = page.locator('main');
    await main.getByRole('combobox', { name: 'Daňová situace' }).click();
    await page.getByRole('option', { name: 'Zaměstnanec' }).click();
    await expect
      .poll(async () => (await (await page.request.get('/api/settings')).json()).settings.taxProfiles['2024']?.situation)
      .toBe('EMPLOYEE');
    await waitForSnapshot(page);
    await expect(main.getByRole('combobox', { name: 'Daňová situace' })).toHaveValue('Zaměstnanec');
  });
});
