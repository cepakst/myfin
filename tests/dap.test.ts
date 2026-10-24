import { describe, expect, it } from 'vitest';
import type { Realization } from '../src/core/fifo.js';
import { defaultSettings, type Settings } from '../src/core/settings.js';
import { computePriloha3, computePriloha4, dapDividends, dapSecurities } from '../src/core/tax/dap.js';
import { buildDividendPayments, dividendYearReport } from '../src/core/tax/dividends.js';
import { securitiesYearReport } from '../src/core/tax/securities.js';
import { yearTaxSummary } from '../src/core/tax/summary.js';
import { emptyLedger, type CashEvent } from '../src/core/types.js';
import { fakeConv, inst } from './helpers.js';

function cash(kind: CashEvent['kind'], instrumentId: string, date: string, amount: number, currency: string): CashEvent {
  return { id: `${kind}${instrumentId}${date}${amount}`, broker: 'DEGIRO', kind, dateTime: `${date}T08:00:00`, date, amount, currency, instrumentId, description: kind };
}

/** Dividend report from (instrument ISIN, currency, gross, withheld) tuples paid in 2024 */
function divReport(items: [string, string, number, number][]) {
  const l = emptyLedger();
  for (const [id, cur, gross, wht] of items) {
    l.instruments.set(id, inst(id, cur));
    l.cash.push(cash('DIVIDEND', id, '2024-04-01', gross, cur), cash('DIVIDEND_TAX', id, '2024-04-01', -wht, cur));
  }
  return dividendYearReport(buildDividendPayments(l, fakeConv, fakeConv), 2024);
}

function real(proceedsCzk: number, costCzk: number, timeTestPassed = false, tradeId = 't'): Realization {
  return {
    id: `${tradeId}-${proceedsCzk}`,
    broker: 'DEGIRO',
    instrumentId: 'X',
    tradeId,
    lotId: 'L',
    sellDate: '2024-06-01',
    sellDateTime: '2024-06-01T10:00:00',
    acqDate: '2020-01-01',
    qty: 1,
    proceedsCzk,
    sellFeesCzk: 0,
    costCzk,
    buyFeesCzk: 0,
    gainCzk: proceedsCzk - costCzk,
    proceedsLocal: 0,
    costLocal: 0,
    currency: 'USD',
    sellPrice: 0,
    holdingDays: 0,
    timeTestPassed,
    timeTestDate: '2023-01-02',
    origin: 'BUY',
  };
}

const settingsFor = (profile: Settings['taxProfiles'][number]): Settings => ({ ...defaultSettings(), taxProfiles: { 2024: profile } });

// US: 100 USD gross / 15 withheld (15 % treaty); FR: 100 EUR gross / 25 withheld (10 % treaty)
const usFr = () =>
  divReport([
    ['US0000000001', 'USD', 100, 15],
    ['FR0000000001', 'EUR', 100, 25],
  ]);

describe('Příloha č. 4 (§16a)', () => {
  it('caps foreign tax at the treaty rate and 15 %', () => {
    const p = computePriloha4(usFr());
    expect(p).toMatchObject({ r401a: 4500, r406: 4500, r409: 4500, r410: 675, r411: 4500, r412: 550, r413: 550, r414: 125 });
  });

  it('rounds the base down to hundreds', () => {
    const p = computePriloha4(divReport([['US0000000001', 'USD', 104.9, 0]]));
    expect(p.r401a).toBe(2098);
    expect(p.r409).toBe(2000);
    expect(p.r414).toBe(300);
  });
});

describe('Příloha č. 3', () => {
  it('limits credit by the coefficient per country', () => {
    const p = computePriloha3(usFr(), 1_000_000, 2024);
    expect(p.r57).toBe(150_000);
    const us = p.countries.find((c) => c.country === 'US')!;
    const fr = p.countries.find((c) => c.country === 'FR')!;
    expect(us).toMatchObject({ r321: 2000, r323: 300, r324: 0.2, r325: 300, r326: 300, r327: 0 });
    expect(fr).toMatchObject({ r321: 2500, r323: 250, r324: 0.25, r325: 375, r326: 250 });
    expect(p.r328).toBe(550);
    expect(p.r330).toBe(150_000 - 550);
  });

  it('gives no credit when there is no tax', () => {
    const p = computePriloha3(usFr(), 4500, 2024);
    expect(p.r328).toBeLessThanOrEqual(p.r57);
  });
});

describe('DAP blocks', () => {
  it('Příloha č. 2 caps expenses at income and reports zero base on loss', () => {
    const b = dapSecurities(securitiesYearReport([real(200_000, 300_000)], 2024));
    const v = Object.fromEntries(b.fields.map((f) => [f.row, f.value]));
    expect(v['tab. sl. 1']).toBe('D');
    expect(v['207']).toBe(200_000);
    expect(v['208']).toBe(200_000);
    expect(v['209']).toBe(0);
  });

  it('uses Příloha č. 4 with §16a and ř. 38 + Příloha č. 3 without it', () => {
    const div = usFr();
    const with16a = dapDividends(div, 2024, { use16a: true, generalBaseCzk: 0, otherCapitalCzk: 0 });
    expect(with16a.map((b) => b.title)).toEqual(['Příloha č. 4 – samostatný základ daně podle § 16a']);
    const general = dapDividends(div, 2024, { use16a: false, generalBaseCzk: 500_000, otherCapitalCzk: 0 });
    expect(general[0].fields[0]).toMatchObject({ row: '38', value: 4500 });
    expect(general.filter((b) => b.title.startsWith('Příloha č. 3'))).toHaveLength(3); // FR, US (additional sheet), totals
    expect(general[2].title).toContain('samostatný list');
  });

  it('never uses §16a before 2021', () => {
    const blocks = dapDividends(usFr(), 2020, { use16a: true, generalBaseCzk: 100_000, otherCapitalCzk: 0 });
    expect(blocks.some((b) => b.title.includes('Příloha č. 4'))).toBe(false);
  });
});

describe('tax summary', () => {
  const noSales = securitiesYearReport([], 2024);

  it('uses the 50 000 Kč filing threshold without other income', () => {
    const below = yearTaxSummary(settingsFor({ situation: 'NO_INCOME' }), noSales, divReport([['FR0000000001', 'EUR', 2000, 200]]), 0);
    expect(below.thresholdIncomeCzk).toBe(50_000);
    expect(below.mustFile).toBe(false);
    const above = yearTaxSummary(settingsFor({ situation: 'NO_INCOME' }), noSales, divReport([['FR0000000001', 'EUR', 2001, 200]]), 0);
    expect(above.mustFile).toBe(true);
  });

  it('suggests the general base when the basic credit covers the dividend tax', () => {
    const div = divReport([['FR0000000001', 'EUR', 2000, 200]]);
    const s = yearTaxSummary(settingsFor({ situation: 'NO_INCOME' }), noSales, div, 0);
    expect(s.use16a).toBe(true);
    expect(s.estimatedTaxDividends16aCzk).toBe(2500);
    expect(s.estimatedTaxDividendsGeneralCzk).toBe(0);
    expect(s.notes.some((n) => n.text.includes('Bez volby §16a'))).toBe(true);
    const g = yearTaxSummary(settingsFor({ situation: 'NO_INCOME', foreign16a: false }), noSales, div, 0);
    expect(g.use16a).toBe(false);
    expect(g.estimatedTaxDividendsCzk).toBe(0);
    expect(g.generalBaseCzk).toBe(50_000);
  });

  it('employee threshold counts foreign dividends', () => {
    const s = yearTaxSummary(settingsFor({ situation: 'EMPLOYEE', otherTaxBase: 600_000 }), noSales, divReport([['US0000000001', 'USD', 1100, 165]]), 0);
    expect(s.mustFile).toBe(true);
    expect(s.estimatedTaxDividendsCzk).toBe(0);
  });

  it('flags §38v reporting for a single exempt sale above 5 M', () => {
    const sec = securitiesYearReport([real(3_000_000, 1_000_000, true, 'a'), real(3_000_000, 1_000_000, true, 'a'), real(4_000_000, 1, true, 'b')], 2024);
    expect(sec.largestExemptSaleCzk).toBe(6_000_000);
    const s = yearTaxSummary(settingsFor({ situation: 'OSVC' }), sec, divReport([]), 0);
    expect(s.notes.some((n) => n.text.includes('§38v'))).toBe(true);
  });
});
