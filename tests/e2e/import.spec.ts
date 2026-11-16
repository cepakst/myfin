import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForSnapshot } from './helpers.js';

const FIXTURES = 'tests/e2e/fixtures';
/** Paths with size and mtime of everything in the (read-only) exports folder. */
function fixtureListing(dir = FIXTURES): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    const st = statSync(p);
    return st.isDirectory() ? fixtureListing(p) : [`${p}|${st.size}|${st.mtimeMs}`];
  });
}
let fixturesBefore: string[] = [];
let fixturesGitBefore = '';
const fixturesGitStatus = () => execFileSync('git', ['status', '--porcelain', '--', FIXTURES], { encoding: 'utf8' }).trim();

const FIXTURE_TX = readFileSync('tests/e2e/fixtures/degiro/Transactions.csv', 'utf8');
const HEADER = FIXTURE_TX.split(/\r?\n/)[0];

/** Synthetic Degiro transaction row (same layout as the fixtures). */
function row(date: string, qty: number, price: number, order: string, isin = 'US0000000004', name = 'BETA INC'): string {
  const n = (x: number) => `"${x.toFixed(2).replace('.', ',')}"`;
  const local = qty * price;
  return `${date},15:30,${name},${isin},NDQ,XNAS,${qty},${n(price)},USD,${n(-local)},USD,${n(-local * 0.9)},"1,10","0,00","0,00",${n(-local * 0.9)},${order}`;
}
// verbatim fixture line, so that it counts as an unchanged row
const ORD4 = FIXTURE_TX.split(String.fromCharCode(10)).map((l) => l.trim()).find((l) => l.endsWith(',ord-4'))!;
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n') + '\n';

async function snapshot(page: Page) {
  await waitForSnapshot(page);
  return (await page.request.get('/api/snapshot')).json();
}
const txUnit = (s: any) => s.storage.units.find((u: any) => u.unit === 'degiro/tx');
const rowsOf = (s: any, year: number): number => txUnit(s).years.find((y: any) => y.year === year)?.rows ?? 0;

async function dropFile(page: Page, name: string, content: string) {
  await page.getByTestId('import-dropzone').locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });
}

/** Restores the fixture data with a replaceAll import through the API. */
async function restoreFixture(page: Page) {
  const prev = await page.request.post('/api/import/preview', { multipart: { file: { name: 'Transactions.csv', mimeType: 'text/csv', buffer: Buffer.from(FIXTURE_TX) } } });
  expect(prev.ok()).toBe(true);
  const { id } = await prev.json();
  const done = await page.request.post('/api/import/commit', { data: { id, mode: 'replaceAll' } });
  expect(done.ok()).toBe(true);
  await waitForSnapshot(page);
}

test.describe.configure({ mode: 'serial' });

test.describe('import of exports', () => {
  test.beforeAll(() => {
    fixturesBefore = fixtureListing();
    fixturesGitBefore = fixturesGitStatus();
  });

  // the fixtures folder is the read-only exports folder: restore the store (not the folder) afterwards
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 5199}` });
    await restoreFixture(page);
    await page.close();
    expect(fixtureListing()).toEqual(fixturesBefore);
    // unchanged against the state before the tests (new, not yet committed fixture files show up in both)
    expect(fixturesGitStatus()).toBe(fixturesGitBefore);
  });

  test('storage shows the imported units and the fixture files in the exports folder are listed as imported', async ({ page }) => {
    const s = await snapshot(page);
    expect(txUnit(s).coverage).toEqual([{ from: '2020-01-05', to: '2024-09-20' }]);
    expect(txUnit(s).years.map((y: any) => y.year)).toEqual([2020, 2022, 2023, 2024]);
    expect(s.storage.loose).toBeUndefined();
    expect(s.storage.inbox.map((f: any) => `${f.path}:${f.status}`).sort()).toEqual([
      'degiro/Account.csv:imported',
      'degiro/Transactions.csv:imported',
      'fio/Vypis_z_uctu-2101112223_20250101-20250131_cislo-1.csv:imported',
      'kb/Vypis_9876543210_20250101_20250131.csv:imported',
      'rb/Pohyby_1112223335_20250101_20250131.csv:imported',
    ]);
    await page.goto('/#/nastaveni');
    const box = page.getByTestId('storage');
    await expect(box).toContainText('Degiro – transakce: 5. 1. 2020 – 20. 9. 2024');
    await expect(box).toContainText('Degiro – výpis z účtu');
    await expect(box).toContainText('Uloženo v');
    await expect(box).toContainText('store');
    const inboxBox = page.getByTestId('inbox');
    await expect(inboxBox).toContainText('degiro/Transactions.csv');
    await expect(inboxBox).toContainText('degiro/Account.csv');
    await expect(inboxBox).toContainText('fio/Vypis_z_uctu-2101112223_20250101-20250131_cislo-1.csv');
    await expect(inboxBox.getByText('importováno')).toHaveCount(5);
    await expect(inboxBox.getByRole('button')).toHaveCount(5); // every non-busy file offers an explicit (re)import
  });

  test('an export with only new rows is merged without a dialog', async ({ page }) => {
    await snapshot(page);
    await page.goto('/#/nastaveni');
    await dropFile(page, 'Transactions.csv', csv(row('03-02-2025', 3, 70, 'ord-new1')));
    await expect(page.getByText(/Transactions\.csv importován \(/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('import-dialog')).toHaveCount(0);
    const s = await snapshot(page);
    expect(rowsOf(s, 2025)).toBe(1);
    // the export covers only its own rows, so the days in between are reported as a gap
    expect(txUnit(s).coverage).toEqual([
      { from: '2020-01-05', to: '2024-09-20' },
      { from: '2025-02-03', to: '2025-02-03' },
    ]);
    await expect(page.getByTestId('storage')).toContainText('3. 2. 2025');
    await expect(page.getByTestId('storage')).toContainText('Nepokryté období: 21. 9. 2024 – 2. 2. 2025');
  });

  test('a conflicting export opens the dialog; mode changes the result column; cancel keeps the data', async ({ page }) => {
    const before = await snapshot(page);
    await page.goto('/#/nastaveni');
    // 2024-02-15 (ord-2) is inside the range of this export but missing from it
    await dropFile(page, 'Transactions.csv', csv(ORD4, row('11-01-2024', 1, 10, 'ord-y'), row('10-01-2024', 1, 10, 'ord-x')));
    // data-testid sits on the Modal root (zero-size wrapper), so visibility is checked on the dialog role
    await expect(page.getByTestId('import-dialog')).toHaveCount(1, { timeout: 15_000 });
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const years = dialog.getByTestId('import-years');
    const yearRow = (y: number) => years.locator('tbody tr').filter({ has: page.getByRole('cell', { name: String(y), exact: true }) });
    const after = (y: number) => yearRow(y).locator('td').last();
    const cells = (y: number) => yearRow(y).locator('td');

    await expect(cells(2024).nth(1)).toHaveText('2'); // stored
    await expect(cells(2024).nth(2)).toHaveText('3'); // in export
    await expect(cells(2024).nth(3)).toHaveText('+2');
    await expect(cells(2024).nth(4)).toHaveText('−1');
    await expect(after(2024)).toHaveText('3'); // merge
    await expect(after(2020)).toHaveText('1');

    await dialog.getByText('Ponechat stávající, přidat jen nové', { exact: true }).click();
    await expect(after(2024)).toHaveText('2');
    await dialog.getByText('Nahradit celou historii', { exact: true }).click();
    await expect(after(2024)).toHaveText('3');
    await expect(after(2020)).toHaveText('0');
    await dialog.getByText('Sloučit', { exact: true }).click();
    await expect(after(2020)).toHaveText('1');

    // widening the period recomputes the table: the 2023 buy is now inside the period and missing
    await dialog.getByTestId('import-from').fill('2023-01-01');
    await expect(cells(2023).nth(4)).toHaveText('−1', { timeout: 10_000 });

    await dialog.getByRole('button', { name: 'Zrušit' }).click();
    await expect(dialog).toHaveCount(0);
    const s = await snapshot(page);
    expect(txUnit(s).years).toEqual(txUnit(before).years);
    expect(s.realizations.length).toBe(before.realizations.length);
  });

  test('the import dialog does not close on Escape', async ({ page }) => {
    await snapshot(page);
    await page.goto('/#/nastaveni');
    await dropFile(page, 'Transactions.csv', csv(ORD4, row('11-01-2024', 1, 10, 'ord-y')));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Zrušit' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('the exports folder must not be or contain the data dir', async ({ page }) => {
    await snapshot(page);
    const before = (await (await page.request.get('/api/settings')).json()).settings;
    const dataDir = join(tmpdir(), 'myfin-e2e');
    try {
      for (const bad of [dataDir, join(dataDir, 'store'), tmpdir()]) {
        const r = await page.request.put('/api/settings', { data: { exportsDir: bad } });
        expect(r.status(), bad).toBe(400);
      }
      const ok = await page.request.put('/api/settings', { data: { exportsDir: resolve(FIXTURES) } });
      expect(ok.status()).toBe(200);
    } finally {
      const back = await page.request.put('/api/settings', { data: { exportsDir: before.exportsDir ?? '' } });
      expect(back.status()).toBe(200);
      await waitForSnapshot(page);
    }
    const after = (await (await page.request.get('/api/settings')).json()).settings;
    expect(after.exportsDir || undefined).toBe(before.exportsDir || undefined);
  });

  test('confirming the merge replaces the rows inside the export period', async ({ page }) => {
    await snapshot(page);
    await page.goto('/#/nastaveni');
    await dropFile(page, 'Transactions.csv', csv(ORD4, row('10-01-2024', 1, 10, 'ord-x')));
    // data-testid sits on the Modal root (zero-size wrapper), so visibility is checked on the dialog role
    await expect(page.getByTestId('import-dialog')).toHaveCount(1, { timeout: 15_000 });
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByTestId('import-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/Transactions\.csv importován \(/).first()).toBeVisible({ timeout: 15_000 });
    const s = await snapshot(page);
    expect(rowsOf(s, 2024)).toBe(2); // ord-2 removed, ord-x added, ord-4 kept
    expect(rowsOf(s, 2020)).toBe(1);
    expect(rowsOf(s, 2022)).toBe(31);
    expect(JSON.stringify(s.realizations)).not.toContain('2024-02-15');
  });

  test('importing is refused (409) in demo mode', async ({ page }) => {
    await snapshot(page);
    try {
      expect((await page.request.put('/api/demo', { data: { enabled: true } })).ok()).toBe(true);
      const r = await page.request.post('/api/import/preview', { multipart: { file: { name: 'Transactions.csv', mimeType: 'text/csv', buffer: Buffer.from(csv(row('03-02-2025', 1, 1, 'o'))) } } });
      expect(r.status()).toBe(409);
      expect((await r.json()).error).toContain('demo');
    } finally {
      await page.request.put('/api/demo', { data: { enabled: false } });
      await waitForSnapshot(page, 90_000);
    }
  });
});
