import { expect, test } from '@playwright/test';
import { trackErrors, waitForSnapshot } from './helpers';

// Splits come from real Yahoo price history, which only the demo instruments (real tickers) have.
const DEMO_TIMEOUT = 150_000;

interface Detail {
  prices: { date: string }[];
  splits: { date: string; ratio: number }[];
}

test.describe('instrument price chart and splits (demo data)', () => {
  test.setTimeout(4 * 60_000);

  test.afterEach(async ({ page }) => {
    await page.request.put('/api/demo', { data: { enabled: false } });
    await waitForSnapshot(page, DEMO_TIMEOUT);
  });

  test('split mode control defaults to adjusted, switches to actual; instruments without splits have no control', async ({ page }) => {
    const { errors, foreignRequests } = trackErrors(page);
    await waitForSnapshot(page);
    await page.request.put('/api/demo', { data: { enabled: true } });
    await waitForSnapshot(page, DEMO_TIMEOUT);
    const snap = await (await page.request.get('/api/snapshot')).json();
    test.skip(!snap.demo, 'demo mode not available');

    let withSplit: string | undefined;
    let withoutSplit: string | undefined;
    for (const i of snap.instruments as { id: string; hasMarket: boolean }[]) {
      if (!i.hasMarket) continue;
      const r = await page.request.get(`/api/instrument/${encodeURIComponent(i.id)}`);
      if (!r.ok()) continue;
      const d = (await r.json()) as Detail;
      if (d.prices.length === 0) continue;
      const first = d.prices[0].date;
      const hasSplit = d.splits.some((s) => s.date > first);
      if (hasSplit) withSplit ??= i.id;
      else withoutSplit ??= i.id;
    }
    test.skip(!withSplit, 'no market data with splits available (Yahoo unreachable?)');

    await page.goto(`/#/instrument/${encodeURIComponent(withSplit!)}`);
    const control = page.getByTestId('split-mode');
    await expect(control).toBeVisible({ timeout: 30_000 });
    await expect(control.getByRole('radio', { name: 'Upraveno o splity' })).toBeChecked();
    await expect(page.locator('main canvas').first()).toBeVisible();
    await expect(page.locator('main')).toContainText('Ceny před splitem jsou přepočtené');

    await control.getByText('Skutečné ceny').click();
    await expect(control.getByRole('radio', { name: 'Skutečné ceny' })).toBeChecked();
    await expect(page.locator('main')).toContainText('při splitu cena skočí');
    await expect(page.locator('main canvas').first()).toBeVisible();

    await control.getByText('Upraveno o splity').click();
    await expect(page.locator('main')).toContainText('Ceny před splitem jsou přepočtené');

    if (withoutSplit) {
      await page.goto(`/#/instrument/${encodeURIComponent(withoutSplit)}`);
      await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('split-mode')).toHaveCount(0);
    }
    // tooltips are canvas-drawn (hover content not asserted)
    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });
});
