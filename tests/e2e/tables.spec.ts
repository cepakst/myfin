import { expect, test, type Locator, type Page } from '@playwright/test';
import { selectYear, trackErrors, waitForSnapshot } from './helpers.js';

const CURRENT_YEAR = String(new Date().getFullYear());

test.describe('tables, default years and insights', () => {
  let tracked: ReturnType<typeof trackErrors>;

  test.beforeEach(async ({ page }) => {
    await waitForSnapshot(page);
    tracked = trackErrors(page);
  });
  test.afterEach(() => {
    expect(tracked.errors).toEqual([]);
    expect(tracked.foreignRequests).toEqual([]);
  });

  const rowsOf = (page: Page) => page.locator('main tbody tr:visible');
  const firstCells = async (page: Page, column: number) => rowsOf(page).evaluateAll((trs, i) => trs.map((tr) => tr.querySelectorAll('td')[i]?.textContent?.trim() ?? ''), column);
  const noEllipsis = (el: Locator) => el.evaluate((n) => n.scrollWidth <= n.clientWidth);

  test('trades: Daň column shows the full status text', async ({ page }) => {
    await page.goto('/#/obchody');
    await selectYear(page, 2024);
    await expect(rowsOf(page)).toHaveCount(2);

    // ACME (bought 2020) passes the time test, BETA (held < 3 years) stays under the 100k limit
    const tt = page.getByText('časový test', { exact: true });
    const limit = page.getByText('limit 100 tis.', { exact: true });
    await expect(tt).toBeVisible();
    await expect(limit).toBeVisible();
    for (const badge of [tt, limit]) {
      expect(await noEllipsis(badge)).toBe(true);
      const cell = badge.locator('xpath=ancestor::td[1]');
      expect(await noEllipsis(cell)).toBe(true);
      const [b, c] = [await badge.boundingBox(), await cell.boundingBox()];
      expect(b!.x + b!.width).toBeLessThanOrEqual(c!.x + c!.width + 1);
    }
    await expect(page.getByText('ZD…')).toHaveCount(0);
  });

  test('trades: tooltip explains the status', async ({ page }) => {
    await page.goto('/#/obchody');
    await selectYear(page, 2024);
    await page.getByText('časový test', { exact: true }).hover();
    await expect(page.getByText('§4 odst. 1 písm. u ZDP')).toBeVisible();
  });

  test('trades: header click sorts, search narrows rows and shows the counter', async ({ page }) => {
    await page.goto('/#/obchody');
    await selectYear(page, 2024);
    const instrument = page.getByRole('button', { name: /^Instrument/ });
    // default sort is by sell date descending (BETA sold later)
    expect(await firstCells(page, 0)).toEqual(['BETA INC', 'ACME CORP']);
    await instrument.click();
    const first = await firstCells(page, 0);
    expect([...first].sort()).toEqual(['ACME CORP', 'BETA INC']);
    await instrument.click();
    const second = await firstCells(page, 0);
    expect(second).toEqual([...first].reverse());

    await expect(page.getByText('2 záznamů')).toBeVisible();
    // diacritics- and case-insensitive search
    await page.getByLabel('Hledat v tabulce').fill('beta');
    await expect(rowsOf(page)).toHaveCount(1);
    await expect(page.getByText('1 z 2 záznamů')).toBeVisible();
    await page.getByLabel('Hledat v tabulce').fill('beta nonexistent');
    await expect(page.getByText('0 z 2 záznamů')).toBeVisible();
    await page.getByLabel('Hledat v tabulce').fill('');
    await expect(page.getByText('2 záznamů')).toBeVisible();
  });

  test('trades: header filter on the Daň column', async ({ page }) => {
    await page.goto('/#/obchody');
    await selectYear(page, 2024);
    await page.locator('th', { hasText: 'Daň' }).getByRole('button').last().click();
    await page.getByRole('combobox', { name: 'Zobrazit jen' }).click();
    await page.getByRole('option', { name: 'časový test' }).click();
    await expect(rowsOf(page)).toHaveCount(1);
    await expect(rowsOf(page)).toContainText('ACME CORP');
    await expect(page.getByText('1 z 2 záznamů')).toBeVisible();
  });

  test('taxes and dividends default to the current year', async ({ page }) => {
    for (const hash of ['#/dane', '#/dividendy', '#/obchody']) {
      await page.goto(`/${hash}`);
      await expect(page.getByRole('combobox', { name: 'Rok' })).toHaveValue(CURRENT_YEAR);
    }
  });

  test('dividends: three tabs, no "Do přiznání", instrument summary', async ({ page }) => {
    await page.goto('/#/dividendy');
    await selectYear(page, 2024);
    for (const name of ['Podle států', 'Podle instrumentů', 'Jednotlivé výplaty']) await expect(page.getByRole('tab', { name })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect(page.getByRole('tab', { name: 'Do přiznání' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Podle instrumentů' }).click();
    await expect(rowsOf(page)).toHaveCount(1);
    await expect(rowsOf(page)).toContainText('ACME CORP');

    await page.getByRole('tab', { name: 'Jednotlivé výplaty' }).click();
    await expect(rowsOf(page)).toHaveCount(2);
  });

  test('insights: period selector switches to a year and back', async ({ page }) => {
    await page.goto('/#/zajimavosti');
    const stat = (label: string) => page.getByText(label, { exact: true }).locator('xpath=../..');
    for (const label of ['Ušlý potenciál (absolutní)', 'Ušlý potenciál po reinvestici', 'Prům. držení ziskových']) await expect(stat(label)).toBeVisible();

    // fixtures contain profitable sales, so the average holding period must be a number
    await expect(stat('Prům. držení ziskových')).toContainText(/\d+ dní/);
    await expect(stat('Prům. držení ziskových')).not.toContainText('NaN');
    const horizon = await stat('Prům. držení ziskových').innerText();

    await page.locator('label', { hasText: /^Rok$/ }).click();
    const yearSelect = page.getByRole('combobox', { name: 'Rok přehledu' });
    await expect(yearSelect).toBeVisible();
    await selectYear(page, 2024, 'Rok přehledu');
    await expect(yearSelect).toHaveValue('2024');
    await expect(page.getByText('Hodnoty v roce 2024')).toBeVisible();
    await expect(stat('Prům. držení ziskových')).toContainText(/\d+ dní/);
    await expect(page.getByText(/\bNaN\b/)).toHaveCount(0);
    expect(await stat('Prům. držení ziskových').innerText()).not.toBe(horizon);

    await selectYear(page, 2022, 'Rok přehledu');
    await expect(stat('Prům. držení ziskových')).toContainText('dní');

    await page.locator('label', { hasText: /^Celý horizont$/ }).click();
    await expect(page.getByText('Hodnoty za celý investiční horizont')).toBeVisible();
    await expect(yearSelect).toHaveCount(0);
    expect(await stat('Prům. držení ziskových').innerText()).toBe(horizon);
    await expect(page.getByText('Výpočet selhal')).toHaveCount(0);
  });

  test('insights: missed-potential table has the reinvestment column', async ({ page }) => {
    await page.goto('/#/zajimavosti');
    await expect(page.getByText(/Ušlý potenciál – prodané pozice/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Ušlo po reinvestici/ })).toBeVisible();
  });

  test('DataGrid body scrolls when there are many rows', async ({ page }) => {
    // the 2022 fixture sells one share of GAMA LTD on 30 days
    await page.goto('/#/obchody');
    await selectYear(page, 2022);
    await expect(rowsOf(page)).toHaveCount(30);
    const viewport = page.locator('main .mantine-ScrollArea-viewport').first();
    const m = await viewport.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, mh: getComputedStyle(el).maxHeight }));
    expect(m.mh).toBe('560px');
    expect(m.sh).toBeGreaterThan(m.ch);
    expect(m.ch).toBeLessThanOrEqual(560);
    await viewport.evaluate((el) => el.scrollTo(0, 300));
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // the header stays visible while scrolling
    await expect(page.getByRole('button', { name: /^Instrument/ })).toBeInViewport();
  });
});
