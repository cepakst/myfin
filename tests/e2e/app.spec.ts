import { expect, test } from '@playwright/test';
import { selectYear, waitForSnapshot } from './helpers.js';

const PAGES = [
  { label: 'Přehled', hash: '#/' },
  { label: 'Výnosy po letech', hash: '#/roky' },
  { label: 'Portfolio a loty', hash: '#/portfolio' },
  { label: 'Realizované obchody', hash: '#/obchody' },
  { label: 'Dividendy', hash: '#/dividendy' },
  { label: 'Daně', hash: '#/dane' },
  { label: 'Daňová optimalizace', hash: '#/optimalizace' },
  { label: 'Zajímavosti', hash: '#/zajimavosti' },
  { label: 'Nastavení a data', hash: '#/nastaveni' },
];

test.describe('app smoke', () => {
  const errors: string[] = [];
  const foreignRequests: string[] = [];

  test.beforeEach(async ({ page }) => {
    // The snapshot endpoint returns 503 while computing; wait so that only real errors are captured.
    await waitForSnapshot(page);
    errors.length = 0;
    foreignRequests.length = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    // Guard rail 3: the UI itself must only talk to the local server.
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol !== 'data:') foreignRequests.push(r.url());
    });
  });

  test('every page renders without errors', async ({ page }) => {
    await page.goto('/');
    for (const p of PAGES) {
      await page.getByRole('link', { name: p.label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${p.hash.replace(/[/#]/g, '\\$&')}$`));
      await expect(page.getByText('Výpočet selhal')).toHaveCount(0);
      await expect(page.locator('main')).not.toBeEmpty();
    }
    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });

  test('taxes page shows synthetic 2024 data', async ({ page }) => {
    await page.goto('/#/dane');
    await selectYear(page, 2024);
    const main = page.locator('main');
    // BETA (held < 3 years) stays under the 100k limit (§4/1/t); ACME (bought 2020) passes the time test (§4/1/u).
    await expect(main).toContainText('nepřesáhly 100 000 Kč');
    await expect(main).toContainText('Prodeje se splněným časovým testem');
    await expect(main).toContainText('Příloha č. 4');
    await expect(main).toContainText('401a');
    // Dividends must stay on the Taxes page (the duplicate tab was removed from Dividends only)
    await expect(main.getByRole('heading', { name: 'Dividendy a kapitálové příjmy (§8)' })).toBeVisible();
    await page.goto('/#/obchody');
    await selectYear(page, 2024);
    await expect(page.locator('main')).toContainText('BETA INC');
    expect(errors).toEqual([]);
  });
});
