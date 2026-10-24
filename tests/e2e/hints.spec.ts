import { expect, test, type Page } from '@playwright/test';
import { selectYear, trackErrors, waitForSnapshot } from './helpers.js';

test.describe('metric explanations', () => {
  let tracked: ReturnType<typeof trackErrors>;

  test.beforeEach(async ({ page }) => {
    await waitForSnapshot(page);
    tracked = trackErrors(page);
  });
  test.afterEach(() => {
    expect(tracked.errors).toEqual([]);
    expect(tracked.foreignRequests).toEqual([]);
  });

  const statCard = (page: Page, label: string) => page.getByText(label, { exact: true }).locator('xpath=../..');

  test('overview: every stat card has an explanation and TWR/XIRR are defined exactly', async ({ page }) => {
    await page.goto('/#/');
    const labels = ['Hodnota portfolia', 'Celkový zisk', 'Výnos (TWR) celkem', /^Letos \(/, 'Dividendy (čistě)', 'Poplatky celkem', 'Realizované zisky / ztráty', /^Odhad daně /];
    for (const l of labels) {
      const card = typeof l === 'string' ? statCard(page, l) : page.getByText(l).locator('xpath=../..');
      await expect(card.getByLabel('Nápověda')).toHaveCount(1);
    }

    await statCard(page, 'Výnos (TWR) celkem').getByLabel('Nápověda').hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('časově vážený výnos');
    await expect(tip).toContainText('(1 + r₁) × (1 + r₂)');
    await expect(tip).toContainText('XIRR');
    await expect(tip).toContainText('/ 365');

    await expect(page.getByTestId('metrics-footnote')).toContainText('TWR (časově vážený výnos)');
    for (const title of ['Vývoj hodnoty portfolia', 'Kumulativní výnos (TWR)', 'Rozložení portfolia'])
      await expect(page.getByText(title, { exact: true }).locator('xpath=..').getByLabel('Nápověda')).toHaveCount(1);
  });

  test('years: table rows explain each component', async ({ page }) => {
    await page.goto('/#/roky');
    const row = page.locator('tr', { hasText: 'Změna nerealizovaných zisků' });
    await row.getByLabel('Nápověda').hover();
    await expect(page.getByRole('tooltip')).toContainText('Dopočet');
    await expect(page.locator('tr', { hasText: 'MWR (IRR)' }).getByLabel('Nápověda')).toHaveCount(1);
  });

  test('table header hint shows a tooltip and does not toggle sorting', async ({ page }) => {
    await page.goto('/#/obchody');
    await selectYear(page, 2024);
    const rows = page.locator('main tbody tr:visible');
    const firstCol = () => rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('td')?.textContent?.trim() ?? ''));
    // default: sell date descending; BETA (held < 3 years) was sold after ACME (held since 2020)
    expect(await firstCol()).toEqual(['BETA INC', 'ACME CORP']);
    const header = page.getByRole('button', { name: /^Drženo/ });
    const icon = header.getByLabel('Nápověda');
    // two header clicks would sort ascending and then descending by holding period (ACME first)
    await icon.click();
    await icon.click();
    await icon.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tooltip')).toContainText('Počet dní mezi nákupem');
    expect(await firstCol()).toEqual(['BETA INC', 'ACME CORP']);
    // control: clicking the title itself still sorts
    await header.getByText('Drženo', { exact: true }).click();
    await header.getByText('Drženo', { exact: true }).click();
    await expect.poll(firstCol).toEqual(['ACME CORP', 'BETA INC']);
  });

  test('taxes: exempt sales and scenario comparison are explained', async ({ page }) => {
    await page.goto('/#/dane');
    for (const row of ['Zisk z prodejů se splněným časovým testem', 'Osvobozený zisk celkem', 'Ztráty z osvobozených prodejů'])
      await expect(page.locator('tr', { hasText: row }).getByLabel('Nápověda')).toHaveCount(1);
    const scenarios = page.getByRole('table', { name: 'Porovnání variant' });
    await expect(scenarios.locator('thead').getByLabel('Nápověda')).toHaveCount(5);
  });

  test('portfolio columns have explanations', async ({ page }) => {
    await page.goto('/#/portfolio');
    for (const name of ['Nákupní cena', 'Hodnota', 'Váha', 'Nerealizovaný zisk', 'Dividendy', 'Časový test'])
      await expect(page.getByRole('button', { name: new RegExp(`^${name}`) }).first().getByLabel('Nápověda')).toHaveCount(1);
  });
});
