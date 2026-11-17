import { expect, test, type Page } from '@playwright/test';
import { trackErrors, waitForSnapshot } from './helpers.js';

// Categorisation of the synthetic bank fixtures (see accounts.spec.ts for the raw data). With the default categories:
//   expenses (flow "expense", all of January 2025):
//     Bydlení a energie 15 000 (KB rent to BYTOVE DRUZSTVO), Hotovost 2 000 (RB ATM), Doprava 1 200 (SHELL),
//     Nezařazeno 700 (KB payment to ZKUSEBNI SPOLECNOST, 5555555/0800), Potraviny 550,50 (ALBERT TEST twice: 450,50 + 100),
//     Poplatky 99 (KB tariff fee), Daně 1,85 (Fio interest tax)           -> total 19 551,35, categorised 18 851,35
//   income: Mzda 50 000 (message MZDA), Úroky 12,34 (Fio interest)
//   neutral: 4 transfers between own accounts (Převod mezi účty) and 1 investment (XTB)
const EMPTY_CONFIG = { version: 1, accounts: {}, ownAccounts: [], categories: null, rules: [], overrides: {} };
const nf = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
const kc = (n: number) => `${nf.format(Math.round(n))} Kč`.replace(/\s/g, ' ');
const flat = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();

type Tx = { key: string; accountId: string; amount: number; flow: string; category: string; categorySource: string; cpLabel: string; ruleId?: string };
type Snap = {
  txs: Tx[];
  categories: { id: string; name: string; kind: string }[];
  categorization: { expenseTotalCzk: number; expenseCategorizedCzk: number; uncategorized: number; suggestions: number };
  config: { categories?: unknown[]; rules: { id: string; category: string; match: Record<string, unknown> }[]; overrides: Record<string, string> };
};

async function accounts(page: Page): Promise<Snap> {
  await waitForSnapshot(page);
  const r = await page.request.get('/api/accounts');
  expect(r.status()).toBe(200);
  return r.json();
}
const putConfig = (page: Page, config: unknown) => page.request.put('/api/accounts/config', { data: config });
const categorize = (page: Page, body: unknown) => page.request.post('/api/accounts/categorize', { data: body as never });
const byAmount = (s: Snap, amount: number) => s.txs.filter((t) => t.amount === amount);
const rows = (page: Page) => page.locator('main tbody tr');

test.describe.configure({ mode: 'serial' });

test.describe('accounts: categorisation', () => {
  let tracked: ReturnType<typeof trackErrors>;

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 5199}` });
    await putConfig(page, EMPTY_CONFIG);
    await page.close();
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

  test('the fixtures are categorised automatically (dictionary, bank type, flow) and one payment stays uncategorised', async ({ page }) => {
    const s = await accounts(page);
    const cat = (amount: number) => byAmount(s, amount).map((t) => `${t.category}/${t.categorySource}`);
    expect(cat(50000)).toEqual(['salary/dictionary']);
    expect(cat(-15000)).toEqual(['housing/dictionary']);
    expect(cat(-99)).toEqual(['fees/bank']);
    expect(cat(12.34)).toEqual(['interest/bank']);
    expect(cat(-1.85)).toEqual(['taxes/bank']);
    expect(cat(-2000)).toEqual(['cash/bank']);
    expect(cat(-450.5)).toEqual(['groceries/dictionary']);
    expect(cat(-100)).toEqual(['groceries/dictionary']);
    expect(cat(-1200)).toEqual(['transport/dictionary']);
    expect(cat(-3000)).toEqual(['investment/flow']);
    expect(cat(-5000)).toEqual(['transfer/flow']);
    expect(cat(-700)).toEqual(['/none']);
    expect(s.categorization.uncategorized).toBe(1);
    expect(s.categorization.suggestions).toBe(0);
    expect(s.categorization.expenseTotalCzk).toBeCloseTo(19551.35, 2);
    expect(s.categorization.expenseCategorizedCzk).toBeCloseTo(18851.35, 2);
    expect(s.config.rules).toEqual([]);
    expect(s.config.overrides).toEqual({});
  });

  test('POST /api/accounts/categorize: validation, assign, null removal, prepended rules, invalid data dropped', async ({ page }) => {
    const s0 = await accounts(page);
    const mystery = byAmount(s0, -700)[0];
    const wolt = byAmount(s0, -1200)[0];

    // bad shapes are refused and change nothing
    for (const bad of [{ assign: [] }, { assign: 'x' }, { assign: null }, { rules: {} }, { rules: 'x' }]) {
      expect((await categorize(page, bad)).status(), JSON.stringify(bad)).toBe(400);
    }
    expect((await accounts(page)).config.overrides).toEqual({});

    // assign
    const r = await categorize(page, { assign: { [mystery.key]: 'gifts', [wolt.key]: 'health' } });
    expect(r.status()).toBe(200);
    const body: Snap = await r.json();
    expect(body.config.overrides).toEqual({ [mystery.key]: 'gifts', [wolt.key]: 'health' });
    expect(body.txs.find((t) => t.key === mystery.key)).toMatchObject({ category: 'gifts', categorySource: 'manual' });
    expect(body.categorization.uncategorized).toBe(0);

    // null removes one override
    const r2: Snap = await (await categorize(page, { assign: { [wolt.key]: null } })).json();
    expect(r2.config.overrides).toEqual({ [mystery.key]: 'gifts' });
    expect(r2.txs.find((t) => t.key === wolt.key)).toMatchObject({ category: 'transport', categorySource: 'dictionary' });
    // "" forces uncategorised
    const r3: Snap = await (await categorize(page, { assign: { [mystery.key]: '' } })).json();
    expect(r3.txs.find((t) => t.key === mystery.key)).toMatchObject({ category: '', categorySource: 'manual' });
    expect(r3.categorization.uncategorized).toBe(1);

    // invalid category and foreign keys are dropped
    const r4: Snap = await (await categorize(page, { assign: { [wolt.key]: 'ghost', 'XTB:1': 'gifts', __proto__: 'gifts' } })).json();
    expect(r4.config.overrides).toEqual({ [mystery.key]: '' });

    // new rules are prepended (the latest decision wins); rules without a condition or with an unknown category are dropped
    const rA = { id: 'rule-a', category: 'gifts', match: { cpAccount: '5555555/0800', direction: 'out' } };
    const rB = { id: 'rule-b', category: 'health', match: { cpAccount: '5555555/0800', text: 'Vklad' } };
    await categorize(page, { rules: [rA] });
    const r5: Snap = await (await categorize(page, { rules: [rB, { id: 'rule-c', category: 'gifts', match: {} }, { id: 'rule-d', category: 'ghost', match: { name: 'X' } }] })).json();
    expect(r5.config.rules.map((x) => x.id)).toEqual(['rule-b', 'rule-a']);
    // the manual "" still wins over the rules; removing it lets the first rule (rule-b) decide
    expect(r5.txs.find((t) => t.key === mystery.key)).toMatchObject({ category: '' });
    const r6: Snap = await (await categorize(page, { assign: { [mystery.key]: null } })).json();
    expect(r6.txs.find((t) => t.key === mystery.key)).toMatchObject({ category: 'health', categorySource: 'rule', ruleId: 'rule-b' });
    // the result is persisted: a fresh read returns the same configuration
    expect((await accounts(page)).config.rules.map((x) => x.id)).toEqual(['rule-b', 'rule-a']);

    // a new rule with the same condition replaces the older one instead of piling up
    const r7: Snap = await (await categorize(page, { rules: [{ id: 'rule-e', category: 'travel', match: { cpAccount: '5555555/0800', direction: 'out' } }] })).json();
    expect(r7.config.rules.map((x) => x.id)).toEqual(['rule-e', 'rule-b']);
    expect(r7.txs.find((t) => t.key === mystery.key)).toMatchObject({ category: 'travel', ruleId: 'rule-e' });
  });

  test('PUT /api/accounts/config merges onto the stored config; categories: null restores the defaults', async ({ page }) => {
    const s0 = await accounts(page);
    const mystery = byAmount(s0, -700)[0];
    await categorize(page, { assign: { [mystery.key]: 'gifts' }, rules: [{ id: 'rule-x', category: 'health', match: { cpAccount: '5555555/0800' } }] });
    // a body without categories/rules/overrides keeps them
    const r = await putConfig(page, { version: 1, accounts: {}, ownAccounts: [] });
    expect(r.status()).toBe(200);
    let s = await accounts(page);
    expect(s.config.rules.map((x) => x.id)).toEqual(['rule-x']);
    expect(s.config.overrides).toEqual({ [mystery.key]: 'gifts' });
    // custom categories: the locked ones are always kept, as neutral
    await putConfig(page, { version: 1, categories: [{ id: 'mine', name: 'Moje', kind: 'expense' }, { id: 'transfer', name: 'T', kind: 'expense' }] });
    s = await accounts(page);
    expect(s.categories.map((c) => `${c.id}:${c.kind}`)).toEqual(['mine:expense', 'transfer:neutral', 'investment:neutral']);
    // rules/overrides pointing to categories that no longer exist are dropped
    expect(s.config.rules).toEqual([]);
    expect(s.config.overrides).toEqual({});
    await putConfig(page, { version: 1, categories: null });
    s = await accounts(page);
    expect(s.categories).toHaveLength(19);
    expect(s.config.categories).toBeUndefined();
    // still requires version 1
    expect((await putConfig(page, { rules: [] })).status()).toBe(400);
  });

  // ---------- Zařadit ----------

  test('Zařadit: choosing a category for a group removes it, raises the share and creates a rule; deleting the rule brings it back', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/ucty/zaradit');
    const table = page.getByTestId('uncategorized-groups');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table).toContainText('ZKUSEBNI SPOLECNOST');
    await expect(table).toContainText(kc(-700));
    await expect(page.getByText(/^96 ?%$/).first()).toBeVisible();
    await expect(page.getByTestId('confirm-all')).toHaveCount(0);

    await page.getByRole('combobox', { name: 'Kategorie pro ZKUSEBNI SPOLECNOST' }).click();
    await page.getByRole('option', { name: 'Ostatní výdaje', exact: true }).click();
    await expect(page.getByTestId('all-categorized')).toBeVisible();
    await expect(page.getByText(/^100 ?%$/).first()).toBeVisible();

    const s = await accounts(page);
    expect(s.categorization).toMatchObject({ uncategorized: 0 });
    expect(s.categorization.expenseCategorizedCzk).toBeCloseTo(19551.35, 2);
    expect(s.config.rules).toHaveLength(1);
    expect(s.config.rules[0]).toMatchObject({ category: 'other-expense', match: { cpAccount: '5555555/0800', direction: 'out' } });
    expect(s.config.overrides).toEqual({});
    expect(byAmount(s, -700)[0]).toMatchObject({ category: 'other-expense', categorySource: 'rule' });

    // the overview hint disappears when nothing is left to categorise
    await page.goto('/#/ucty');
    await expect(page.getByTestId('accounts-table')).toBeVisible();
    await expect(page.getByTestId('categorize-hint')).toHaveCount(0);

    // the rule is listed in the settings
    await page.goto('/#/nastaveni');
    const rules = page.getByTestId('rules-table');
    await expect(rules.locator('tbody tr')).toHaveCount(1);
    await expect(rules).toContainText('5555555/0800');
    await expect(rules).toContainText('jen odchozí');
    await expect(rules.locator('tbody tr').first().locator('td').nth(2)).toHaveText('1');
    // delete it and save
    await page.getByRole('button', { name: 'Smazat pravidlo' }).click();
    await expect(page.getByTestId('rules-table')).toHaveCount(0);
    await page.getByTestId('categories-save').click();
    await expect(page.getByText('Kategorie a pravidla uloženy').first()).toBeVisible();
    expect((await accounts(page)).config.rules).toEqual([]);

    await page.goto('/#/ucty/zaradit');
    await expect(page.getByTestId('uncategorized-groups').locator('tbody tr')).toHaveCount(1);
    await expect(page.getByTestId('all-categorized')).toHaveCount(0);
  });

  test('overview hint shows the share of categorised spending and links to Zařadit', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/ucty');
    const hint = page.getByTestId('categorize-hint');
    await expect(hint).toBeVisible();
    expect(flat(await hint.textContent())).toMatch(/Zařazeno 96 ?% výdajů\. Nezařazených transakcí: 1\./);
    await hint.getByRole('link', { name: 'Zařadit' }).click();
    await expect(page).toHaveURL(/#\/ucty\/zaradit$/);
  });

  // ---------- Transakce ----------

  test('Transakce: changing one transaction asks "Jen tuto" vs all similar', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/ucty/transakce?kategorie=groceries');
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first().getByTestId('tx-category')).toContainText('Potraviny');
    // the source icon explains the category in its title
    await expect(rows(page).first().getByTestId('source-dictionary')).toHaveAttribute('title', /ALBERT/);

    // only this one
    await rows(page).first().getByTestId('tx-category').click();
    await page.getByRole('option', { name: 'Nákupy', exact: true }).click();
    await expect(page.getByText('Zařadit i podobné transakce?')).toBeVisible();
    await page.getByRole('button', { name: 'Jen tuto' }).click();
    await expect(rows(page)).toHaveCount(1); // the filter shows groceries only
    let s = await accounts(page);
    const albert = s.txs.filter((t) => t.cpLabel === 'ALBERT TEST');
    expect(albert.map((t) => `${t.category}/${t.categorySource}`).sort()).toEqual(['groceries/dictionary', 'shopping/manual']);
    expect(Object.values(s.config.overrides)).toEqual(['shopping']);
    expect(s.config.rules).toEqual([]);

    // back to automatic (null removes the override)
    await categorize(page, { assign: Object.fromEntries(Object.keys(s.config.overrides).map((k) => [k, null])) });
    s = await accounts(page);
    expect(s.txs.filter((t) => t.cpLabel === 'ALBERT TEST').every((t) => t.category === 'groceries')).toBe(true);

    // all similar + rule
    await page.goto('/#/ucty/transakce?kategorie=groceries');
    await expect(rows(page)).toHaveCount(2);
    await rows(page).first().getByTestId('tx-category').click();
    await page.getByRole('option', { name: 'Dárky', exact: true }).click();
    await expect(page.getByTestId('assign-all')).toContainText('Všechny (2) + pravidlo');
    await page.getByTestId('assign-all').click();
    await expect(page.getByText('Žádné záznamy')).toBeVisible();
    s = await accounts(page);
    expect(s.txs.filter((t) => t.cpLabel === 'ALBERT TEST').map((t) => `${t.category}/${t.categorySource}`)).toEqual(['gifts/rule', 'gifts/rule']);
    expect(s.config.rules).toHaveLength(1);
    expect(s.config.rules[0]).toMatchObject({ category: 'gifts', match: { name: 'ALBERT TEST', direction: 'out' } });
    expect(s.config.overrides).toEqual({});
  });

  test('Transakce: a payment of a counterparty with a single transaction is assigned without the question', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/ucty/transakce?kategorie=-');
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().getByTestId('tx-category').click();
    await page.getByRole('option', { name: 'Dárky', exact: true }).click();
    await expect(page.getByText('Zařadit i podobné transakce?')).toHaveCount(0);
    await expect(page.getByText('Žádné záznamy')).toBeVisible();
    const s = await accounts(page);
    expect(byAmount(s, -700)[0]).toMatchObject({ category: 'gifts', categorySource: 'manual' });
    expect(s.config.rules).toEqual([]);
  });

  test('Transakce: the category filter and the month parameter in the URL', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/ucty/transakce?kategorie=-');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('ZKUSEBNI SPOLECNOST');
    await expect(rows(page).first().getByTestId('tx-category')).toContainText('Nezařazeno');
    await expect(page.getByTestId('filter-categories')).toBeVisible();

    await page.goto('/#/ucty/transakce?kategorie=cash&kategorie=transport');
    await expect(rows(page)).toHaveCount(2);
    await page.goto('/#/ucty/transakce?kategorie=transfer');
    await expect(rows(page)).toHaveCount(4);

    await page.goto('/#/ucty/transakce?mesic=2025-01');
    await expect(rows(page)).toHaveCount(15);
    await expect(page.getByText('2025-01 ✕')).toBeVisible();
    await page.goto('/#/ucty/transakce?mesic=2025-02');
    await expect(page.getByText('Žádné záznamy')).toBeVisible();
    await page.getByText('2025-02 ✕').click();
    await expect(page).toHaveURL(/#\/ucty\/transakce$/);
    await expect(rows(page)).toHaveCount(15);

    // the filter control writes to the URL
    await page.getByTestId('filter-categories').click();
    await page.getByRole('option', { name: 'Nezařazeno' }).click();
    await expect(page).toHaveURL(/kategorie=-/);
    await expect(rows(page)).toHaveCount(1);
  });

  // ---------- Výdaje a příjmy ----------

  test('Výdaje a příjmy: category table for the fixture year, switching to income', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/ucty/kategorie');
    await page.getByRole('combobox', { name: 'Období' }).click();
    await page.getByRole('option', { name: 'Rok 2025', exact: true }).click();
    const table = page.getByTestId('category-table');
    await expect(table.locator('tbody tr')).toHaveCount(7);
    const row = (name: string) => table.locator('tbody tr').filter({ hasText: name });
    await expect(row('Bydlení a energie')).toContainText(kc(15000));
    await expect(row('Hotovost')).toContainText(kc(2000));
    await expect(row('Doprava')).toContainText(kc(1200));
    await expect(row('Nezařazeno')).toContainText(kc(700));
    await expect(row('Potraviny')).toContainText(kc(550.5));
    await expect(row('Poplatky')).toContainText(kc(99));
    await expect(row('Daně')).toContainText(kc(1.85));
    // sorted by amount, the biggest first; transfers and the investment are not in the statistics
    await expect(table.locator('tbody tr').first()).toContainText('Bydlení a energie');
    await expect(table).not.toContainText('Převod mezi účty');
    await expect(table).not.toContainText('Investice');
    await expect(page.locator('main').getByText('Výdaje celkem', { exact: true })).toBeVisible();
    await expect(page.locator('main').getByText('Výdaje celkem', { exact: true }).locator('xpath=../..')).toContainText(kc(19551.35));

    await page.locator('.mantine-SegmentedControl-root').getByText('Příjmy', { exact: true }).click();
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(row('Mzda')).toContainText(kc(50000));
    await expect(row('Úroky')).toContainText(kc(12.34));
    await expect(page.locator('main').getByText('Příjmy celkem', { exact: true })).toBeVisible();

    // a link in the table goes to the transactions of that category
    await page.getByRole('link', { name: 'Mzda' }).click();
    await expect(page).toHaveURL(/#\/ucty\/transakce\?kategorie=salary$/);
    await expect(rows(page)).toHaveCount(1);
  });

  test('Výdaje a příjmy: a manual category change is reflected in the table', async ({ page }) => {
    const s = await accounts(page);
    await categorize(page, { assign: { [byAmount(s, -700)[0].key]: 'travel' } });
    await page.goto('/#/ucty/kategorie');
    await page.getByRole('combobox', { name: 'Období' }).click();
    await page.getByRole('option', { name: 'Celá historie', exact: true }).click();
    const table = page.getByTestId('category-table');
    await expect(table.locator('tbody tr').filter({ hasText: 'Cestování' })).toContainText(kc(700));
    await expect(table.locator('tbody tr').filter({ hasText: 'Nezařazeno' })).toHaveCount(0);
  });

  // ---------- navigation and start page ----------

  test('navigation has "Výdaje a příjmy" and "Zařadit"', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('nav');
    await expect(nav.getByRole('link', { name: 'Výdaje a příjmy', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Zařadit', exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Výdaje a příjmy', exact: true }).click();
    await expect(page).toHaveURL(/#\/ucty\/kategorie$/);
    await nav.getByRole('link', { name: 'Zařadit', exact: true }).click();
    await expect(page).toHaveURL(/#\/ucty\/zaradit$/);
    await expect(nav.getByRole('link', { name: 'Zařadit', exact: true })).toHaveAttribute('data-active', 'true');
  });

  test('start page lists the biggest spending categories of the last 12 months', async ({ page }) => {
    await accounts(page);
    // the fixtures are from January 2025: pretend that "today" is shortly after, so they fall into the 12-month window
    await page.route('**/api/accounts', async (route) => {
      const resp = await route.fetch();
      const json = await resp.json();
      json.today = '2025-02-15';
      json.months = json.months.filter((m: { month: string }) => m.month <= '2025-02'); // the home page takes the last 12 of the months
      await route.fulfill({ response: resp, json });
    });
    await page.goto('/#/');
    const line = page.getByText(/Největší výdaje za 12 měsíců/);
    await expect(line).toBeVisible({ timeout: 30_000 });
    const text = flat(await line.textContent());
    expect(text).toContain(`Bydlení a energie ${kc(15000)}`);
    expect(text).toContain(`Hotovost ${kc(2000)}`);
    expect(text).toContain(`Doprava ${kc(1200)}`);
    expect(text).not.toContain('Potraviny');
    await page.getByRole('link', { name: '(vše)' }).click();
    await expect(page).toHaveURL(/#\/ucty\/kategorie$/);
  });

  // ---------- settings: categories ----------

  test('settings: adding and deleting a category; deleting "transfer" keeps transfers out of the statistics', async ({ page }) => {
    await accounts(page);
    await page.goto('/#/nastaveni');
    const table = page.getByTestId('categories-table');
    await expect(table.locator('tbody tr')).toHaveCount(19);
    // the categories the flow classification relies on cannot be deleted or changed to another kind
    await expect(page.getByLabel('Smazat kategorii Převod mezi účty')).toBeDisabled();
    await expect(page.getByLabel('Smazat kategorii Investice')).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Druh kategorie transfer' })).toBeDisabled();
    await page.getByRole('button', { name: 'Přidat kategorii' }).click();
    await page.getByLabel('Název kategorie nova-kategorie').fill('Zvířata');
    await page.getByLabel('Smazat kategorii Dárky').click();
    await page.getByTestId('categories-save').click();
    await expect(page.getByText('Kategorie a pravidla uloženy').first()).toBeVisible();

    const s = await accounts(page);
    expect(s.categories.map((c) => c.name)).toContain('Zvířata');
    expect(s.categories.map((c) => c.id)).not.toContain('gifts');
    expect(s.categories.map((c) => c.id)).toContain('transfer');
    expect(byAmount(s, -5000)[0]).toMatchObject({ category: 'transfer', flow: 'transfer' });
    expect(s.categorization.expenseTotalCzk).toBeCloseTo(19551.35, 2);
  });
});
