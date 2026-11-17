import { expect, test, type Page } from '@playwright/test';
import { trackErrors, waitForSnapshot } from './helpers.js';

// Combined start page (net worth). Synthetic fixtures only: Degiro (portfolio since 2020) + Fio/KB/RB statements
// from January 2025. The fixtures end long before "today", so both series span many months and the
// 12-month window is not empty; API responses are rewritten only for the empty/liability/accounts-only cases
// (documented in each test).
const EMPTY_CONFIG = { version: 1, accounts: {}, ownAccounts: [], categories: null, rules: [], overrides: {} };
const flat = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
const nf = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
const kc = (n: number) => `${nf.format(Math.round(n))} Kč`.replace(/\s/g, ' ');
/** First Czech-formatted amount in the text ("-1 234 Kč", with NBSP/narrow NBSP and U+2212) -> number. */
const parseKc = (t: string): number => {
  const m = /([-−]?)\s*(\d[\d\s]*)\s*Kč/.exec(t.replace(/[  ]/g, ' '));
  if (!m) throw new Error(`no amount in "${t}"`);
  return (m[1] ? -1 : 1) * Number(m[2].replace(/\s/g, ''));
};

type AccSnap = {
  today: string;
  accounts: { id: string; balanceCzk: number | null; hidden: boolean }[];
  months: { month: string; income: number; expense: number; net: number }[];
  totals: { balanceCzk: number; income12m: number; expense12m: number };
  categorization: { uncategorized: number };
};
type Snap = {
  files: unknown[];
  today: string;
  performance: { total: { value: number; invested: number }; daily: { date: string; value: number }[] };
  dividendYears: { year: number }[];
};

async function apis(page: Page): Promise<{ a: AccSnap; s: Snap }> {
  await waitForSnapshot(page);
  const a = await (await page.request.get('/api/accounts')).json();
  const s = await (await page.request.get('/api/snapshot')).json();
  return { a, s };
}
const statCard = (page: Page, label: string) => page.locator('main').getByText(label, { exact: true }).locator('xpath=../..');
const table = (page: Page) => page.getByTestId('networth-change');
const row = (page: Page, label: string) => table(page).locator('tr').filter({ hasText: label });
/** Signed amount of a "+ label" / "− label" row (the row shows the absolute value and the sign in the label). */
const rowAmount = async (page: Page, label: string) => {
  const text = flat(await row(page, label).textContent());
  return (text.startsWith('−') ? -1 : 1) * Math.abs(parseKc(text.replace(/^[+−]\s*/, '').replace(label, '')));
};
const monthLabel = (m: string) => `${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

test.describe.configure({ mode: 'serial' });

test.describe('start page: net worth', () => {
  let tracked: ReturnType<typeof trackErrors>;

  test.beforeEach(async ({ page }) => {
    await waitForSnapshot(page);
    await page.request.put('/api/accounts/config', { data: EMPTY_CONFIG });
    tracked = trackErrors(page);
  });
  test.afterEach(async () => {
    expect(tracked.errors).toEqual([]);
    expect(tracked.foreignRequests).toEqual([]);
  });

  test('net worth = accounts total + portfolio value; stats, chart and the removed tiles', async ({ page }) => {
    const { a, s } = await apis(page);
    await page.goto('/#/');
    const main = page.locator('main');
    const card = statCard(page, 'Čisté jmění');
    await expect.poll(async () => flat(await card.textContent()), { timeout: 30_000 }).toContain(kc(a.totals.balanceCzk + s.performance.total.value));
    const text = flat(await card.textContent());
    expect(text).toContain(`účty ${kc(a.totals.balanceCzk)}`);
    expect(text).toContain(`investice ${kc(s.performance.total.value)}`);
    for (const l of ['Změna za 12 měsíců', 'Ušetřeno za 12 měsíců']) await expect(main.getByText(l, { exact: true })).toBeVisible();
    await expect(main.getByText(/^Tento měsíc \(\d+\/\d{4}\)$/)).toBeVisible();
    for (const l of ['Na účtech', 'Celkový majetek']) await expect(main.getByText(l, { exact: true })).toHaveCount(0);
    await expect(statCard(page, 'Ušetřeno za 12 měsíců')).toContainText(kc(a.totals.income12m - a.totals.expense12m));
    const chart = main.getByText('Vývoj čistého jmění', { exact: true }).locator('xpath=ancestor::div[contains(@class,"mantine-Card-root")]');
    await expect(chart).toBeVisible();
    await expect(chart.locator('canvas, svg').first()).toBeVisible();
  });

  test('module sections: uncategorised link navigates, unrealised P/L, dividends of this year', async ({ page }) => {
    const { a, s } = await apis(page);
    expect(a.categorization.uncategorized).toBeGreaterThan(0);
    await page.goto('/#/');
    const main = page.locator('main');
    await expect(main.getByText(`Nezařazených transakcí: ${a.categorization.uncategorized}`)).toBeVisible({ timeout: 30_000 });
    await expect(main.getByText(/nerealizovaný/)).toBeVisible();
    // the fixture dividends are from 2024 only: the line for the current year shows up only when the API has that year
    const thisYear = Number(s.today.slice(0, 4));
    await expect(main.getByText(/Dividendy \d{4} \(čistě\)/)).toHaveCount(s.dividendYears.some((d) => d.year === thisYear) ? 1 : 0);
    await main.getByRole('link', { name: 'Zařadit →' }).click();
    await expect(page).toHaveURL(/#\/ucty\/zaradit$/);
  });

  test('"what changed" table: rows sum to the change and the start row follows the period switch', async ({ page }) => {
    const { a, s } = await apis(page);
    await page.goto('/#/');
    await expect(table(page)).toBeVisible({ timeout: 30_000 });
    const control = page.getByLabel('Období změny');
    await expect(control).toBeVisible();
    for (const l of ['Ušetřeno z příjmů', 'Zhodnocení investic', 'Ostatní', 'Dnes']) await expect(table(page).getByText(l)).toBeVisible();

    const startRow = table(page).locator('tr').first();
    const startLabel = async () => flat(await startRow.locator('td').first().textContent());
    let prev = await startLabel(); // default period: 12 months
    const labels: Record<string, string> = { '12': prev };
    for (const [key, name] of [['1', 'Tento měsíc'], ['12', '12 měsíců'], ['all', 'Vše']] as const) {
      await control.getByText(name, { exact: true }).click();
      await expect.poll(startLabel).not.toBe(prev);
      prev = await startLabel();
      labels[key] = prev;
      const start = parseKc(flat(await startRow.locator('td').nth(1).textContent()));
      const todayText = flat(await row(page, 'Dnes').textContent()).replace('Dnes', '');
      const end = parseKc(todayText);
      const change = parseKc(/\((.*)\)/.exec(todayText)![1]);
      const saved = await rowAmount(page, 'Ušetřeno z příjmů');
      const market = await rowAmount(page, 'Zhodnocení investic');
      const other = await rowAmount(page, 'Ostatní');
      // "Nově přidané účty" is shown only when the opening balances in the window are >= 1 Kč
      const newAcc = (await row(page, 'Nově přidané účty').count()) ? await rowAmount(page, 'Nově přidané účty') : 0;
      const elsewhere = (await row(page, 'Investováno z jiných zdrojů').count()) ? await rowAmount(page, 'Investováno z jiných zdrojů') : 0;
      // every displayed amount is rounded on its own: allow a few Kč
      expect(Math.abs(start + saved + market + newAcc + elsewhere + other - end), `${name} start+rows vs end`).toBeLessThanOrEqual(4);
      expect(Math.abs(end - start - change), `${name} end-start vs change`).toBeLessThanOrEqual(2);
    }
    expect(new Set(Object.values(labels)).size).toBe(3);
    // "Vše" starts at the first month of either series
    const firstMonth = [a.months[0]?.month, s.performance.daily[0]?.date.slice(0, 7)].filter((x): x is string => !!x).sort()[0];
    expect(labels.all).toContain(monthLabel(firstMonth));
    // the 12-month stat tile agrees with the 12-month table
    await control.getByText('12 měsíců', { exact: true }).click();
    await expect.poll(startLabel).toBe(labels['12']);
    const todayText = flat(await row(page, 'Dnes').textContent());
    const tableChange = parseKc(/\((.*)\)/.exec(todayText)![1]);
    const tile = flat(await statCard(page, 'Změna za 12 měsíců').textContent()).replace('Změna za 12 měsíců', '');
    expect(parseKc(tile)).toBe(tableChange);
  });

  test('composition section renders; negative balances become liabilities (accounts response rewritten)', async ({ page }) => {
    await apis(page);
    await page.goto('/#/');
    const section = page.getByText('Složení majetku', { exact: true });
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.locator('xpath=ancestor::div[contains(@class,"mantine-Card-root")]').locator('canvas, svg').first()).toBeVisible();
    await expect(page.getByText(/^Závazky/)).toHaveCount(0);
    // the fixtures have no loan: make one visible account negative in the response
    await page.route('**/api/accounts', async (route) => {
      const resp = await route.fetch();
      const json = await resp.json();
      const acc = json.accounts.find((x: { hidden: boolean; balanceCzk: number | null }) => !x.hidden && x.balanceCzk !== null);
      acc.balanceCzk = -1234;
      await route.fulfill({ response: resp, json });
    });
    await page.reload(); // hash-only navigation would not refetch the data
    const liab = page.getByText(/^Závazky \(záporné zůstatky účtů\):/);
    await expect(liab).toBeVisible({ timeout: 30_000 });
    expect(parseKc(flat(await liab.textContent()))).toBe(-1234);
  });

  test('empty state offers the demo data (responses rewritten to "no data")', async ({ page }) => {
    await apis(page);
    await page.route('**/api/accounts', async (route) => {
      const resp = await route.fetch();
      const json = await resp.json();
      json.accounts = [];
      await route.fulfill({ response: resp, json });
    });
    await page.route('**/api/snapshot', async (route) => {
      const resp = await route.fetch();
      const json = await resp.json();
      json.files = [];
      json.demo = false;
      await route.fulfill({ response: resp, json });
    });
    await page.goto('/#/');
    await expect(page.getByTestId('home-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Zobrazit demo data' })).toBeVisible();
    await expect(table(page)).toHaveCount(0);
    await expect(page.getByText('Zatím žádné výpisy z účtů.')).toBeVisible();
    await expect(page.getByText('Zatím žádné exporty od brokerů.')).toBeVisible();
  });

  test('only accounts (no broker exports): net worth is the accounts total, market gain is 0', async ({ page }) => {
    const { a } = await apis(page);
    await page.route('**/api/snapshot', async (route) => {
      const resp = await route.fetch();
      const json = await resp.json();
      json.files = [];
      await route.fulfill({ response: resp, json });
    });
    await page.goto('/#/');
    await expect.poll(async () => flat(await statCard(page, 'Čisté jmění').textContent()), { timeout: 30_000 }).toContain(`účty ${kc(a.totals.balanceCzk)} · investice ${kc(0)}`);
    await expect(page.getByText('Zatím žádné exporty od brokerů.')).toBeVisible();
    await expect(table(page)).toBeVisible();
    expect(await rowAmount(page, 'Zhodnocení investic')).toBe(0);
  });

  test('stale statements note: the fixtures end in January 2025, long before today', async ({ page }) => {
    await apis(page);
    await page.goto('/#/');
    const note = page.getByTestId('stale-statements');
    await expect(note).toBeVisible({ timeout: 30_000 });
    expect(flat(await note.textContent())).toMatch(/Poslední pohyb na účtech je z \d+\. \d+\. 2025/);
    await expect(page.getByText(/Poslední data jsou z/)).toHaveCount(0);
  });

  test('"Tento měsíc" shows the current month and the 12-month tile label depends on the history length', async ({ page }) => {
    await apis(page);
    await page.goto('/#/');
    await expect(page.locator('main').getByText(/^Tento měsíc \(\d+\/\d{4}\)$/)).toBeVisible({ timeout: 30_000 });
    // the series reaches back to 2020 (portfolio): more than 12 months
    await expect(page.locator('main').getByText('Změna za 12 měsíců', { exact: true })).toBeVisible();
  });
});
