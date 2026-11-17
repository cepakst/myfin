import { expect, test, type Page } from '@playwright/test';
import { trackErrors, waitForSnapshot } from './helpers.js';

// Transakce: period filter, counterparty filter (link from Zařadit) and pagination. Fixture data are from January 2025
// (see accounts.spec.ts); the pagination test uses the bundled demo bank statements (more than 100 movements).
const DEMO_TIMEOUT = 150_000;
const EMPTY_CONFIG = { version: 1, accounts: {}, ownAccounts: [], categories: null, rules: [], overrides: {} };
const flat = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
const putConfig = (page: Page, config: unknown) => page.request.put('/api/accounts/config', { data: config });
const bodyRows = (page: Page) => page.locator('main tbody tr');

test.describe.configure({ mode: 'serial' });

test.describe('transactions: period, counterparty and paging', () => {
  let tracked: ReturnType<typeof trackErrors>;

  test.beforeEach(async ({ page }) => {
    await waitForSnapshot(page);
    await putConfig(page, EMPTY_CONFIG);
    tracked = trackErrors(page);
  });

  test.afterEach(async ({ page }) => {
    await putConfig(page, EMPTY_CONFIG);
    expect(tracked.errors).toEqual([]);
    expect(tracked.foreignRequests).toEqual([]);
  });

  test('Zařadit: the counterparty link opens Transakce filtered to it; the badge removes the filter', async ({ page }) => {
    await page.goto('/#/ucty/zaradit');
    const link = page.getByTestId('group-link');
    await expect(link).toHaveCount(1);
    await expect(link).toContainText('ZKUSEBNI SPOLECNOST');
    await link.click();
    // only the uncategorised transactions the group counts
    await expect(page).toHaveURL(/#\/ucty\/transakce\?protistrana=out%7C.+&kategorie=-&obdobi=all$/);
    const badge = page.getByTestId('filter-counterparty');
    await expect(badge).toBeVisible();
    expect(flat(await badge.textContent())).toBe('Pro: ZKUSEBNI SPOLECNOST ✕');
    await expect(page.getByTestId('filter-period')).toHaveValue('Celá historie');
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(bodyRows(page)).toContainText('ZKUSEBNI SPOLECNOST');

    await badge.click();
    await expect(page.getByTestId('filter-counterparty')).toHaveCount(0);
    await expect(page).not.toHaveURL(/protistrana/);
    await expect(page).toHaveURL(/kategorie=-&obdobi=all/);
    await expect(bodyRows(page)).toHaveCount(1);
  });

  test('period select changes rows and URL; the default period removes the parameter', async ({ page }) => {
    await page.goto('/#/ucty/transakce');
    await expect(page.getByTestId('filter-period')).toHaveValue('Posledních 12 měsíců');
    await expect(page.getByText('Žádné záznamy')).toBeVisible();
    await expect(page).not.toHaveURL(/obdobi/);

    await page.getByTestId('filter-period').click();
    await page.getByRole('option', { name: 'Rok 2025' }).click();
    await expect(page).toHaveURL(/obdobi=2025$/);
    await expect(bodyRows(page)).toHaveCount(15);

    await page.getByTestId('filter-period').click();
    await page.getByRole('option', { name: 'Celá historie' }).click();
    await expect(page).toHaveURL(/obdobi=all$/);
    await expect(bodyRows(page)).toHaveCount(15);

    await page.getByTestId('filter-period').click();
    await page.getByRole('option', { name: 'Posledních 12 měsíců' }).click();
    await expect(page).not.toHaveURL(/obdobi/);
    await expect(page.getByText('Žádné záznamy')).toBeVisible();
  });

  test('a month in the URL overrides the period, shows a badge and can be removed', async ({ page }) => {
    await page.goto('/#/ucty/transakce?mesic=2025-01');
    await expect(page.getByTestId('filter-period')).toHaveCount(0);
    await expect(bodyRows(page)).toHaveCount(15);
    const badge = page.getByText('1/2025 ✕');
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page).not.toHaveURL(/mesic/);
    await expect(page.getByTestId('filter-period')).toHaveValue('Posledních 12 měsíců');
    await expect(page.getByText('Žádné záznamy')).toBeVisible();
  });

  test('a table with at most 100 rows has no pagination', async ({ page }) => {
    await page.goto('/#/ucty/transakce?obdobi=all');
    await expect(bodyRows(page)).toHaveCount(15);
    await expect(page.getByText(/\d+–\d+ z \d+/)).toHaveCount(0);
  });
});

test.describe('transactions: pagination (demo data)', () => {
  test.setTimeout(4 * 60_000);

  test.afterEach(async ({ page }) => {
    await page.request.put('/api/demo', { data: { enabled: false } });
    await waitForSnapshot(page, DEMO_TIMEOUT);
  });

  test('100 rows per page, page 2 differs, changing a filter returns to page 1', async ({ page }) => {
    await waitForSnapshot(page);
    const { errors, foreignRequests } = trackErrors(page);
    await page.request.put('/api/demo', { data: { enabled: true } });
    await expect
      .poll(async () => {
        const r = await page.request.get('/api/accounts');
        return r.status() === 200 && (await r.json()).demo === true;
      }, { timeout: DEMO_TIMEOUT })
      .toBe(true);
    const snap: { today: string; txs: { date: string }[] } = await (await page.request.get('/api/accounts')).json();
    const total = snap.txs.length;
    expect(total).toBeGreaterThan(200);
    const fmt = (n: number) => n.toLocaleString('cs-CZ').replace(/\s/g, ' ');

    await page.goto('/#/ucty/transakce?obdobi=all');
    await expect(page.getByText(/^1–100 z /)).toBeVisible({ timeout: 60_000 });
    expect(flat(await page.getByText(/^1–100 z /).textContent())).toBe(`1–100 z ${fmt(total)}`);
    await expect(bodyRows(page)).toHaveCount(100);
    const first = flat(await bodyRows(page).first().textContent());

    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(page.getByText(/^101–200 z /)).toBeVisible();
    await expect(bodyRows(page)).toHaveCount(100);
    expect(flat(await bodyRows(page).first().textContent())).not.toBe(first);

    // categorising a row (a new snapshot) keeps the page; opening the picker re-renders the page too
    await bodyRows(page).first().getByTestId('tx-category').click();
    await page.getByRole('option', { name: 'Dárky' }).click();
    const onlyThis = page.getByRole('button', { name: 'Jen tuto' });
    if (await onlyThis.isVisible().catch(() => false)) await onlyThis.click();
    await expect(page.getByText('Zařazeno').first()).toBeVisible();
    await expect(page.getByText(/^101–200 z /)).toBeVisible();

    // a different set of rows starts on the first page again (search narrows it to still more than 100 rows or fewer)
    await page.getByLabel('Hledat v tabulce').fill('a');
    await expect(page.getByText(/^101–200 z /)).toHaveCount(0);
    await expect(bodyRows(page).first()).toBeVisible();
    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });
});
