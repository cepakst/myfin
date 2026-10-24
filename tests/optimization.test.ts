import { describe, expect, it } from 'vitest';
import { buildTips, type DividendChoice } from '../src/core/analytics/optimization.js';
import { securitiesYearReport } from '../src/core/tax/securities.js';

const tipsFor = (dividendChoices: DividendChoice[]) =>
  buildTips({ year: 2025, lots: [], report: securitiesYearReport([], 2025), dividends: [], fxComparison: [], dividendChoices, today: '2025-06-01' }).filter((t) => t.id.startsWith('div16a-'));

const choice = (p: Partial<DividendChoice>): DividendChoice => ({
  year: 2024,
  use16a: true,
  foreignDividendsCzk: 20_000,
  estimatedTaxDividends16aCzk: 0,
  estimatedTaxDividendsGeneralCzk: 0,
  ...p,
});

describe('dividend taxation tip', () => {
  it('warns when the other variant is cheaper and reports the saving', () => {
    const [t] = tipsFor([choice({ use16a: true, estimatedTaxDividends16aCzk: 1500, estimatedTaxDividendsGeneralCzk: 0 })]);
    expect(t.id).toBe('div16a-2024');
    expect(t.severity).toBe('warning');
    expect(t.title).toContain('obecný základ');
    expect(t.amountCzk).toBe(1500);
    expect(t.text).toContain('sekci Daně');
  });

  it('confirms when the chosen variant is already the cheaper one', () => {
    const [t] = tipsFor([choice({ use16a: true, estimatedTaxDividends16aCzk: 1500, estimatedTaxDividendsGeneralCzk: 3600 })]);
    expect(t.severity).toBe('success');
    expect(t.title).toContain('§16a');
    expect(t.title).toContain('zvoleno');
    expect(t.amountCzk).toBeUndefined();
  });

  it('reports a negligible difference as info', () => {
    const [t] = tipsFor([choice({ estimatedTaxDividends16aCzk: 1500, estimatedTaxDividendsGeneralCzk: 1450 })]);
    expect(t.severity).toBe('info');
    expect(t.title).toContain('podobně');
  });

  it('skips years before 2021 and years without foreign dividends', () => {
    expect(tipsFor([choice({ year: 2020, estimatedTaxDividendsGeneralCzk: 5000 }), choice({ year: 2024, foreignDividendsCzk: 0 })])).toEqual([]);
  });

  it('creates one tip per year', () => {
    const tips = tipsFor([choice({ year: 2024, estimatedTaxDividends16aCzk: 1000 }), choice({ year: 2025, estimatedTaxDividendsGeneralCzk: 1000 })]);
    expect(tips.map((t) => t.id)).toEqual(['div16a-2024', 'div16a-2025']);
  });
});
