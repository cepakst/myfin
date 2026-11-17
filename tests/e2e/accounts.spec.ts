import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackErrors, waitForSnapshot } from './helpers.js';

// Synthetic bank fixtures (tests/e2e/fixtures/fio|kb|rb): a Fio savings account, a KB current account and an RB card account.
//   Fio 2101112223/2010: opening 10 000, +5 000 from KB, interest +12,34, tax -1,85          -> closing 15 010,49
//   KB  9876543210/0100: opening 20 000, salary +50 000, rent -15 000, -5 000 to Fio, -8 000 to RB,
//                        -3 000 to XTB (investment), -700 to an unknown account 5555555/0800, fee -99  -> closing 38 201
//   RB  1112223335/5500: no balance in the export; +8 000 from KB, card -450,50, -1 200 and -100 (ALBERT twice), ATM -2 000   -> sum of movements 4 249,50
const FIO = '2101112223/2010';
const KB = '9876543210/0100';
const RB = '1112223335/5500';
const DATA_DIR = join(tmpdir(), 'myfin-e2e');
const FIXTURES = 'tests/e2e/fixtures';
const DEMO_TIMEOUT = 150_000;

const nf = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
/** Formats like the UI (czk()) and normalises the no-break spaces */
const kc = (n: number) => `${nf.format(Math.round(n))} Kč`.replace(/\s/g, ' ');
const flat = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();

type Acc = { id: string; displayName: string; balance: number; balanceCzk: number; anchored: boolean; hidden: boolean; product: string; productInferred: string; txCount: number; lastDate: string };
type AccTx = { accountId: string; date: string; amount: number; flow: string; otherAccount?: string; cpName?: string };
type Snap = {
  demo: boolean;
  accounts: Acc[];
  txs: AccTx[];
  months: { month: string; income: number; expense: number; invested: number; net: number }[];
  totals: { balanceCzk: number; income12m: number; expense12m: number; invested12m: number; savingsRate12m: number | null };
  config: { version: 1; accounts: Record<string, unknown>; ownAccounts: unknown[] };
  warnings: { source: string; message: string }[];
};

async function accounts(page: Page): Promise<Snap> {
  await waitForSnapshot(page);
  const r = await page.request.get('/api/accounts');
  expect(r.status()).toBe(200);
  return r.json();
}
const putConfig = (page: Page, config: unknown) => page.request.put('/api/accounts/config', { data: config });
// PUT merges onto the stored config, so categories, rules and overrides are reset explicitly
const EMPTY_CONFIG = { version: 1, accounts: {}, ownAccounts: [], categories: null, rules: [], overrides: {} };

function fixtureListing(dir = FIXTURES): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      const st = statSync(p);
      return st.isDirectory() ? fixtureListing(p) : [`${p}|${st.size}|${st.mtimeMs}`];
    });
}

const statCard = (page: Page, label: string) => page.locator('main').getByText(label, { exact: true }).locator('xpath=../..');
const accountRow = (page: Page, id: string) => page.getByTestId('accounts-table').locator('tbody tr').filter({ hasText: id });

test.describe.configure({ mode: 'serial' });

test.describe('accounts module', () => {
  let tracked: ReturnType<typeof trackErrors>;
  let fixturesBefore: string[] = [];

  test.beforeAll(() => {
    fixturesBefore = fixtureListing();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 5199}` });
    await putConfig(page, EMPTY_CONFIG);
    await page.close();
    // the exports folder is read-only for the app
    expect(fixtureListing()).toEqual(fixturesBefore);
  });

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

  // ---------- data ----------

  test('the bank fixtures are imported: balances, flows and monthly totals', async ({ page }) => {
    const s = await accounts(page);
    expect(s.demo).toBe(false);
    expect(s.accounts.map((a) => a.id)).toEqual([FIO, KB, RB]);
    const by = Object.fromEntries(s.accounts.map((a) => [a.id, a]));
    expect(by[FIO]).toMatchObject({ balance: 15010.49, anchored: true, productInferred: 'savings', txCount: 3 });
    expect(by[KB]).toMatchObject({ balance: 38201, anchored: true, product: 'current', txCount: 7 });
    expect(by[RB]).toMatchObject({ balance: 4249.5, anchored: false, displayName: 'RB · Běžný · 1112223335', txCount: 5 });
    expect(s.totals.balanceCzk).toBeCloseTo(15010.49 + 38201 + 4249.5, 2);
    expect(s.warnings.filter((w) => w.message.includes('nesedí'))).toEqual([]);
    expect(s.warnings.filter((w) => w.message.includes('neobsahuje zůstatek'))).toHaveLength(1);

    const jan = s.months.find((m) => m.month === '2025-01')!;
    expect(jan.income).toBeCloseTo(50012.34, 2);
    expect(jan.expense).toBeCloseTo(19551.35, 2);
    expect(jan.invested).toBeCloseTo(3000, 2);
    expect(jan.net).toBeCloseTo(30460.99, 2);

    // transfers between the fixture accounts are recognised in both directions; the XTB deposit is an investment
    const transfers = s.txs.filter((t) => t.flow === 'transfer');
    expect(transfers.map((t) => `${t.accountId}>${t.otherAccount}:${t.amount}`).sort()).toEqual([`${FIO}>${KB}:5000`, `${KB}>${FIO}:-5000`, `${KB}>${RB}:-8000`, `${RB}>${KB}:8000`].sort());
    const inv = s.txs.filter((t) => t.flow === 'investment');
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ accountId: KB, amount: -3000 });
    // an unknown counterparty is an ordinary expense until the user marks it as own/investment
    expect(s.txs.find((t) => t.amount === -700)!.flow).toBe('expense');
    expect((await (await page.request.get('/api/status')).json()).accountsGeneratedAt).toBeTruthy();
  });

  test('PUT /api/accounts/config validates the body and never overwrites the configuration with garbage', async ({ page }) => {
    await accounts(page);
    expect((await putConfig(page, { version: 1, accounts: { [RB]: { alias: 'Moje karta' } }, ownAccounts: [] })).status()).toBe(200);
    expect((await accounts(page)).accounts.find((a) => a.id === RB)!.displayName).toBe('Moje karta');
    for (const bad of [null, 'x', [], { accounts: {} }, { version: 2 }]) {
      const r = await page.request.put('/api/accounts/config', { data: bad as never });
      expect([400, 415], JSON.stringify(bad)).toContain(r.status());
    }
    expect((await accounts(page)).accounts.find((a) => a.id === RB)!.displayName).toBe('Moje karta');
    // malformed parts of a valid envelope are dropped
    const r = await putConfig(page, { version: 1, accounts: { [FIO]: { product: 'bogus', hidden: 'yes' }, 'not an account': { alias: 'x' } }, ownAccounts: [{ account: 'nonsense' }] });
    expect(r.status()).toBe(200);
    expect((await r.json()).config).toMatchObject({ version: 1, accounts: {}, ownAccounts: [] });
  });

  // ---------- navigation and start page ----------

  test('navigation has the groups Účty and Investice; "/" is the start page, "/investice" the investment overview', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('nav');
    await expect(nav.getByText('Účty', { exact: true })).toBeVisible();
    await expect(nav.getByText('Investice', { exact: true })).toBeVisible();
    for (const l of ['Přehled', 'Přehled účtů', 'Transakce', 'Přehled investic', 'Výnosy po letech', 'Daně', 'Nastavení a data']) await expect(nav.getByRole('link', { name: l, exact: true })).toBeVisible();
    // "Přehled účtů" must not stay active on "Transakce" and vice versa
    await nav.getByRole('link', { name: 'Transakce', exact: true }).click();
    await expect(page).toHaveURL(/#\/ucty\/transakce$/);
    await expect(nav.getByRole('link', { name: 'Transakce', exact: true })).toHaveAttribute('data-active', 'true');
    await expect(nav.getByRole('link', { name: 'Přehled účtů', exact: true })).not.toHaveAttribute('data-active', 'true');

    await page.goto('/#/');
    const main = page.locator('main');
    for (const l of ['Čisté jmění', 'Účty', 'Investice']) await expect(main.getByText(l, { exact: true }).first()).toBeVisible();
    await expect(main.getByText('Na účtech', { exact: true })).toHaveCount(0); // the old tiles moved into the net worth sub-line and the module sections
    await expect(main.getByText('Hodnota portfolia', { exact: true })).toHaveCount(0);
    const s = await accounts(page);
    await expect.poll(async () => flat(await statCard(page, 'Čisté jmění').textContent())).toContain(`účty ${kc(s.totals.balanceCzk)}`);
    await expect(main.getByText(/Zůstatek:.*účtů: 3/)).toBeVisible();
    // links to both modules
    await main.getByRole('link', { name: /Přehled účtů/ }).click();
    await expect(page).toHaveURL(/#\/ucty$/);

    await page.goto('/#/investice');
    await expect(page.locator('main').getByText('Hodnota portfolia', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('main').getByText('Čisté jmění', { exact: true })).toHaveCount(0);
  });

  // ---------- overview ----------

  test('accounts overview: table, totals, estimate badge and charts', async ({ page }) => {
    const s = await accounts(page);
    await page.goto('/#/ucty');
    const table = page.getByTestId('accounts-table');
    await expect(table.locator('tbody tr')).toHaveCount(3);
    const fio = accountRow(page, FIO);
    await expect(fio).toContainText('Fio banka');
    await expect(fio).toContainText('Spořicí účet');
    await expect(fio).toContainText(kc(15010.49));
    await expect(fio).not.toContainText('odhad');
    const kb = accountRow(page, KB);
    await expect(kb).toContainText('Komerční banka');
    await expect(kb).toContainText('Běžný účet');
    await expect(kb).toContainText(kc(38201));
    await expect(kb).toContainText('31. 1. 2025');
    const rb = accountRow(page, RB);
    // default name: bank · product · number (the export's account name is not used)
    await expect(rb).toContainText('RB · Běžný · 1112223335');
    await expect(rb).toContainText('Raiffeisenbank');
    await expect(rb).toContainText(kc(4249.5));
    await expect(rb.getByText('odhad', { exact: true })).toBeVisible(); // the RB export carries no balance

    // stat cards equal the API values
    await expect(statCard(page, 'Zůstatek na účtech')).toContainText(kc(s.totals.balanceCzk));
    await expect(statCard(page, 'Příjmy (12 měsíců)')).toContainText(kc(s.totals.income12m));
    await expect(statCard(page, 'Výdaje (12 měsíců)')).toContainText(kc(s.totals.expense12m));
    await expect(statCard(page, 'Investováno (12 měsíců)')).toContainText(kc(s.totals.invested12m));
    await expect(statCard(page, 'Míra úspor')).toBeVisible();

    // charts render (ECharts canvas/svg) and the grouping can be switched
    await expect(page.getByText('Zůstatky v čase', { exact: true })).toBeVisible();
    await expect(page.getByText('Příjmy a výdaje po měsících', { exact: true })).toBeVisible();
    await expect.poll(() => page.locator('main canvas').count()).toBeGreaterThanOrEqual(2);
    for (const g of ['Banky', 'Produkty', 'Účty']) {
      await page.getByRole('group', { name: 'Seskupit podle' }).or(page.locator('.mantine-SegmentedControl-root')).getByText(g, { exact: true }).first().click();
      await expect(page.getByRole('radio', { name: g, exact: true })).toBeChecked();
      await expect(page.locator('main canvas').first()).toBeVisible();
    }
    await expect(page.getByTestId('accounts-warnings')).toContainText('neobsahuje zůstatek');
  });

  // ---------- transactions ----------

  test('transactions: filters by account (link from the overview), bank, product and search', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/ucty');
    await accountRow(page, RB).getByRole('link', { name: 'RB · Běžný · 1112223335' }).click();
    await expect(page).toHaveURL(/#\/ucty\/transakce\?ucet=1112223335%2F5500$/);
    // the default period is the last 12 months; the fixtures are older
    await expect(page.getByTestId('filter-period')).toHaveValue('Posledních 12 měsíců');
    await page.getByTestId('filter-period').click();
    await page.getByRole('option', { name: 'Celá historie' }).click();
    await expect(page).toHaveURL(/obdobi=all/);
    await expect(statCard(page, 'Pohybů')).toContainText('5');
    await expect(page.getByText(/^5 záznamů/)).toBeVisible();
    await expect(page.getByTestId('filter-accounts')).toBeVisible();
    // RB: income 0 (the only credit is a transfer), expenses 450,50 + 1 200 + 2 000
    await expect(statCard(page, 'Příjmy')).toContainText(kc(0));
    await expect(statCard(page, 'Výdaje')).toContainText(kc(3750.5));
    const body = page.locator('main tbody');
    await expect(body).toContainText('ALBERT TEST');
    await expect(body).toContainText('SHELL TEST');
    await expect(body).toContainText('Převod mezi účty');

    // clear the account filter: everything (3 + 7 + 5 movements)
    await page.goto('/#/ucty/transakce?obdobi=all');
    await expect(statCard(page, 'Pohybů')).toContainText('15');
    await expect(statCard(page, 'Příjmy')).toContainText(kc(50012.34));
    await expect(statCard(page, 'Výdaje')).toContainText(kc(19551.35));
    await expect(statCard(page, 'Na investice')).toContainText(kc(3000));
    // the flow label and the category button of every transfer both read "Převod mezi účty"
    await expect(body.getByText('Převod mezi účty', { exact: true })).toHaveCount(8);
    await expect(body.getByText('Investice', { exact: true })).toHaveCount(2);

    // bank filter
    await page.getByRole('combobox', { name: 'Banky' }).click();
    await page.getByRole('option', { name: 'Fio banka' }).click();
    await expect(statCard(page, 'Pohybů')).toContainText('3');
    await page.keyboard.press('Escape');
    // product filter on top of it: Fio is a savings account, so "Běžný účet" leaves nothing
    await page.getByRole('combobox', { name: 'Produkty' }).click();
    await page.getByRole('option', { name: 'Běžný účet' }).click();
    await expect(statCard(page, 'Pohybů')).toContainText('0');
    await expect(page.getByText('Žádné záznamy')).toBeVisible();
    await page.keyboard.press('Escape');

    // search (the stat cards ignore it, the record counter shows it); a route change resets the filters
    await page.goto('/#/ucty');
    await page.goto('/#/ucty/transakce?obdobi=all');
    await page.getByLabel('Hledat v tabulce').fill('albert');
    await expect(page.getByText(/2 z 15 záznamů/)).toBeVisible();
    await expect(statCard(page, 'Pohybů')).toContainText('15');
    await page.getByLabel('Hledat v tabulce').fill('XTB');
    await expect(page.getByText(/1 z 15 záznamů/)).toBeVisible();
    await page.getByLabel('Hledat v tabulce').fill('nothing like this');
    await expect(page.getByText('Žádné záznamy')).toBeVisible();
  });

  // ---------- settings ----------

  test('settings: rename an account, set its product and a balance (removes the estimate badge)', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/nastaveni');
    const grid = page.getByTestId('accounts-settings');
    await expect(grid.locator('tbody tr')).toHaveCount(3);
    await page.getByLabel(`Název účtu ${RB}`).fill('Karta Jan');
    await page.getByRole('combobox', { name: `Produkt ${RB}` }).click();
    await page.getByRole('option', { name: 'Spořicí účet' }).click();
    await page.getByLabel(`Datum zůstatku ${RB}`).fill('2025-02-10');
    await page.getByLabel(`Zůstatek ${RB}`, { exact: true }).fill('5000');
    await page.getByTestId('accounts-save').click();
    await expect(page.getByText('Nastavení účtů uloženo').first()).toBeVisible();

    const s = await accounts(page);
    const rb = s.accounts.find((a) => a.id === RB)!;
    expect(rb).toMatchObject({ displayName: 'Karta Jan', product: 'savings', productInferred: 'current', anchored: true, balance: 5000 });
    expect(s.config.accounts[RB]).toMatchObject({ alias: 'Karta Jan', product: 'savings', anchor: { date: '2025-02-10', balance: 5000 } });
    expect(s.warnings.some((w) => w.message.includes('neobsahuje zůstatek'))).toBe(false);

    await page.goto('/#/ucty');
    const row = accountRow(page, RB);
    await expect(row).toContainText('Karta Jan');
    await expect(row).toContainText('Spořicí účet');
    await expect(row).toContainText(kc(5000));
    await expect(row.getByText('odhad', { exact: true })).toHaveCount(0);
    await expect(statCard(page, 'Zůstatek na účtech')).toContainText(kc(15010.49 + 38201 + 5000));

    // the configuration survives a reload of the page
    await page.reload();
    await page.goto('/#/nastaveni');
    await expect(page.getByLabel(`Název účtu ${RB}`)).toHaveValue('Karta Jan');
  });

  test('settings: a hidden account is excluded from the totals but its transactions stay listed', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/nastaveni');
    await page.getByLabel(`Skrýt ${FIO}`).check();
    await page.getByTestId('accounts-save').click();
    await expect(page.getByText('Nastavení účtů uloženo').first()).toBeVisible();

    const s = await accounts(page);
    expect(s.accounts.find((a) => a.id === FIO)!.hidden).toBe(true);
    expect(s.totals.balanceCzk).toBeCloseTo(38201 + 4249.5, 2);
    await page.goto('/#/ucty');
    await expect(accountRow(page, FIO)).toContainText('skrytý');
    await expect(statCard(page, 'Zůstatek na účtech')).toContainText(kc(38201 + 4249.5));
    await expect(statCard(page, 'Zůstatek na účtech')).toContainText('2 účtů');
    await page.goto('/#/ucty/transakce?obdobi=all');
    await expect(statCard(page, 'Pohybů')).toContainText('15');
    // the Fio interest (+12,34) no longer counts as income
    await expect(statCard(page, 'Příjmy')).toContainText(kc(50000));
    await page.goto('/#/');
    await expect(statCard(page, 'Čisté jmění')).toContainText(`účty ${kc(38201 + 4249.5)}`);
  });

  test('settings: an investment account turns an expense into an investment; an invalid number is refused', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/nastaveni');
    await page.getByRole('button', { name: 'Přidat účet' }).click();
    await page.getByLabel('Číslo účtu', { exact: true }).fill('12');
    await page.getByTestId('accounts-save').click();
    await expect(page.getByText(/Neplatné číslo účtu/)).toBeVisible();
    expect((await accounts(page)).config.ownAccounts).toEqual([]);

    await page.getByLabel('Číslo účtu', { exact: true }).fill('0005555555/0800');
    await page.getByLabel('Popis', { exact: true }).fill('Zkušební broker');
    await page.getByRole('combobox', { name: 'Druh účtu' }).click();
    await page.getByRole('option', { name: 'Investiční účet' }).click();
    await page.getByTestId('accounts-save').click();
    await expect(page.getByText('Nastavení účtů uloženo').first()).toBeVisible();

    const s = await accounts(page);
    expect(s.config.ownAccounts).toEqual([{ account: '5555555/0800', label: 'Zkušební broker', kind: 'investment' }]);
    expect(s.txs.find((t) => t.amount === -700)!.flow).toBe('investment');
    const jan = s.months.find((m) => m.month === '2025-01')!;
    expect(jan.invested).toBeCloseTo(3700, 2);
    expect(jan.expense).toBeCloseTo(19551.35 - 700, 2);

    await page.goto('/#/ucty/transakce?obdobi=all');
    await expect(statCard(page, 'Na investice')).toContainText(kc(3700));
    // switching the account to "own" makes it a transfer instead
    await page.goto('/#/nastaveni');
    await page.getByRole('combobox', { name: 'Druh účtu' }).click();
    await page.getByRole('option', { name: 'Vlastní účet' }).click();
    await page.getByTestId('accounts-save').click();
    await expect(page.getByText('Nastavení účtů uloženo').first()).toBeVisible();
    expect((await accounts(page)).txs.find((t) => t.amount === -700)!.flow).toBe('transfer');
    // and removing it restores the expense
    await page.getByLabel('Odebrat účet').click();
    await page.getByTestId('accounts-save').click();
    await expect(page.getByText('Nastavení účtů uloženo').first()).toBeVisible();
    expect((await accounts(page)).txs.find((t) => t.amount === -700)!.flow).toBe('expense');
  });

  test('the bank files are listed in the storage and exports folder sections of the settings', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/nastaveni');
    const storage = page.getByTestId('storage');
    await expect(storage).toContainText('Fio');
    await expect(storage).toContainText('2101112223');
    await expect(storage).toContainText('9876543210');
    await expect(storage).toContainText('1112223335');
    const inbox = page.getByTestId('inbox');
    await expect(inbox).toContainText('Vypis_z_uctu-2101112223_20250101-20250131_cislo-1.csv');
    await expect(inbox).toContainText('Pohyby_1112223335_20250101_20250131.csv');
  });
});

// ---------- demo mode ----------

test.describe('accounts module in demo mode', () => {
  test.setTimeout(4 * 60_000);

  const read = (name: string) => (existsSync(join(DATA_DIR, name)) ? readFileSync(join(DATA_DIR, name), 'utf8') : null);

  test.afterEach(async ({ page }) => {
    await page.request.put('/api/demo', { data: { enabled: false } });
    await waitForSnapshot(page, DEMO_TIMEOUT);
  });

  test('demo shows the bank accounts and keeps its configuration in accounts.demo.json only', async ({ page }) => {
    await waitForSnapshot(page);
    const { errors, foreignRequests } = trackErrors(page);
    const realBefore = read('accounts.json');
    const realSnap: Snap = await (await page.request.get('/api/accounts')).json();
    expect(realSnap.accounts).toHaveLength(3);

    await page.request.put('/api/demo', { data: { enabled: true } });
    await expect
      .poll(async () => {
        const r = await page.request.get('/api/accounts');
        return r.status() === 200 && (await r.json()).demo === true;
      }, { timeout: DEMO_TIMEOUT })
      .toBe(true);
    const demo: Snap = await (await page.request.get('/api/accounts')).json();
    expect(demo.accounts).toHaveLength(4);
    expect(demo.accounts.map((a) => a.id).sort()).toEqual(['1234567890/5500', '1234567891/5500', '19-2000145398/0100', '2101234567/2010']);
    expect(demo.txs.length).toBeGreaterThan(1000);
    expect(demo.txs.some((t) => t.flow === 'transfer')).toBe(true);

    // a change in demo mode goes to the demo file
    const r = await putConfig(page, { version: 1, accounts: { '1234567890/5500': { alias: 'Demo karta' } }, ownAccounts: [] });
    expect(r.status()).toBe(200);
    expect(JSON.parse(read('accounts.demo.json')!).accounts['1234567890/5500'].alias).toBe('Demo karta');
    expect(read('accounts.json')).toBe(realBefore);

    await page.goto('/#/ucty');
    await expect(page.locator('header').getByTestId('demo-badge')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('accounts-table').locator('tbody tr')).toHaveCount(4);
    await expect(page.getByTestId('accounts-table')).toContainText('Demo karta');
    await expect(page.getByTestId('accounts-table')).not.toContainText('1112223335');

    // back to the own exports: the fixtures and the untouched real configuration
    await page.request.put('/api/demo', { data: { enabled: false } });
    await waitForSnapshot(page, DEMO_TIMEOUT);
    const back: Snap = await (await page.request.get('/api/accounts')).json();
    expect(back.demo).toBe(false);
    expect(back.accounts.map((a) => a.id)).toEqual([FIO, KB, RB]);
    expect(JSON.stringify(back.config)).not.toContain('Demo karta');
    expect(read('accounts.json')).toBe(realBefore);
    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });

  test('demo mode refuses imports and the start page shows both modules', async ({ page }) => {
    await waitForSnapshot(page);
    await page.request.put('/api/demo', { data: { enabled: true } });
    await waitForSnapshot(page, DEMO_TIMEOUT);
    await page.goto('/#/');
    const main = page.locator('main');
    await expect(main.getByText('Čisté jmění', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(main.getByText(/Zůstatek:.*účtů: 4/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('header').getByTestId('demo-badge')).toBeVisible();
  });
});
