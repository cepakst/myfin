import { describe, expect, it } from 'vitest';
import type { Realization } from '../src/core/fifo.js';
import { computeInsights } from '../src/core/analytics/insights.js';
import type { PriceProvider } from '../src/core/analytics/prices.js';
import { defaultSettings, type Settings } from '../src/core/settings.js';
import { buildDividendPayments, dividendYearReport, type DividendPayment } from '../src/core/tax/dividends.js';
import { securitiesYearReport } from '../src/core/tax/securities.js';
import { yearTaxSummary } from '../src/core/tax/summary.js';
import { emptyLedger, type CashEvent } from '../src/core/types.js';
import { fakeConv, inst, ledgerWith } from './helpers.js';

const TODAY = '2026-06-01';

let seq = 0;
function real(instrumentId: string, tradeId: string, sellDate: string, qty: number, proceedsCzk: number, costCzk: number, holdingDays: number): Realization {
  seq++;
  return {
    id: `R${seq}`,
    broker: 'DEGIRO',
    instrumentId,
    tradeId,
    lotId: `L${seq}`,
    sellDate,
    sellDateTime: `${sellDate}T10:00:00`,
    acqDate: '2020-01-01',
    qty,
    proceedsCzk,
    sellFeesCzk: 0,
    costCzk,
    buyFeesCzk: 0,
    gainCzk: proceedsCzk - costCzk,
    proceedsLocal: 0,
    costLocal: 0,
    currency: 'USD',
    sellPrice: 0,
    holdingDays,
    timeTestPassed: false,
    timeTestDate: '2023-01-02',
    origin: 'BUY',
  };
}

/** Constant market price in USD for every instrument */
const prices = (price: number): PriceProvider => ({
  price: () => ({ price, currency: 'USD', date: TODAY, source: 'market' }),
  hasMarket: () => true,
});

const ledger = () => ledgerWith([inst('US0000000001', 'USD', 'ACME'), inst('US0000000004', 'USD', 'BETA')], []);

function dividend(date: string, net: number): DividendPayment {
  const l = emptyLedger();
  l.instruments.set('US0000000001', inst('US0000000001', 'USD', 'ACME'));
  const c = (kind: CashEvent['kind'], amount: number): CashEvent => ({ id: `${kind}${date}`, broker: 'DEGIRO', kind, dateTime: `${date}T08:00:00`, date, amount, currency: 'USD', instrumentId: 'US0000000001', description: kind });
  l.cash.push(c('DIVIDEND', net));
  return buildDividendPayments(l, fakeConv, fakeConv)[0];
}

describe('computeInsights – year filter', () => {
  const econ = [
    real('US0000000001', 'A', '2023-05-01', 1, 2000, 1000, 400),
    real('US0000000001', 'B', '2024-05-01', 1, 3000, 1000, 800),
    real('US0000000004', 'C', '2024-07-01', 1, 500, 900, 100),
  ];
  const l = ledgerWith(
    [inst('US0000000001', 'USD', 'ACME'), inst('US0000000004', 'USD', 'BETA')],
    [],
  );
  l.cash.push({ id: 'f1', broker: 'DEGIRO', kind: 'FEE', dateTime: '2024-01-02T08:00:00', date: '2024-01-02', amount: -1, currency: 'USD', description: 'fee' });
  l.cash.push({ id: 'f2', broker: 'DEGIRO', kind: 'FEE', dateTime: '2023-01-02T08:00:00', date: '2023-01-02', amount: -2, currency: 'USD', description: 'fee' });
  const divs = [dividend('2023-04-01', 10), dividend('2024-04-01', 30)];

  it('covers all years without a filter', () => {
    const i = computeInsights(l, econ, divs, prices(1), fakeConv, TODAY);
    expect(i.years.map((y) => y.year)).toEqual([2023, 2024]);
    expect(i.total.gainsCzk).toBe(1000 + 2000);
    expect(i.total.lossesCzk).toBe(400);
    expect(i.total.dividendsNetCzk).toBe(40 * 20);
    expect(i.total.accountFeesCzk).toBe(3 * 20);
  });

  it('restricts sales, fees and dividends to the selected year', () => {
    const i = computeInsights(l, econ, divs, prices(1), fakeConv, TODAY, { year: 2024 });
    expect(i.years.map((y) => y.year)).toEqual([2024]);
    expect(i.total.gainsCzk).toBe(2000);
    expect(i.total.lossesCzk).toBe(400);
    expect(i.total.dividendsNetCzk).toBe(30 * 20);
    expect(i.total.accountFeesCzk).toBe(20);
    expect(i.bestTrades.map((t) => t.tradeId)).toEqual(['B', 'C']);
    expect(i.missed.map((m) => m.instrumentId).sort()).toEqual(['US0000000001', 'US0000000004']);
    expect(i.missed.find((m) => m.instrumentId === 'US0000000001')!.soldQty).toBe(1);
  });

  it('returns empty results for a year without activity', () => {
    const i = computeInsights(l, econ, divs, prices(1), fakeConv, TODAY, { year: 2019 });
    expect(i.years).toEqual([]);
    expect(i.bestTrades).toEqual([]);
    expect(i.missed).toEqual([]);
    expect(i.avgHoldingDaysWinners).toBeNull();
    expect(i.avgHoldingDaysLosers).toBeNull();
    expect(i.total.dividendsNetCzk).toBe(0);
  });
});

describe('computeInsights – average holding days', () => {
  it('is not NaN when a trade has zero-quantity (corporate action) realizations', () => {
    const econ = [
      real('US0000000001', 'A', '2024-05-01', 2, 3000, 1000, 100),
      real('US0000000001', 'A', '2024-05-01', 2, 1000, 500, 300),
      // cash-in-lieu style row: zero quantity, positive proceeds
      real('US0000000001', 'CA', '2024-06-01', 0, 50, 0, 0),
      real('US0000000004', 'L', '2024-07-01', 1, 100, 500, 50),
      real('US0000000004', 'L', '2024-07-01', 0, 0, 0, 0),
    ];
    const i = computeInsights(ledger(), econ, [], prices(1), fakeConv, TODAY);
    expect(Number.isNaN(i.avgHoldingDaysWinners)).toBe(false);
    expect(Number.isNaN(i.avgHoldingDaysLosers)).toBe(false);
    // trade A: quantity-weighted (2*100 + 2*300) / 4 = 200; the qty-0 trade CA is ignored
    expect(i.avgHoldingDaysWinners).toBe(200);
    expect(i.avgHoldingDaysLosers).toBe(50);
  });

  it('is null when there are no winners or losers', () => {
    const i = computeInsights(ledger(), [real('US0000000001', 'A', '2024-05-01', 1, 100, 500, 10)], [], prices(1), fakeConv, TODAY);
    expect(i.avgHoldingDaysWinners).toBeNull();
    expect(i.avgHoldingDaysLosers).toBe(10);
  });
});

describe('computeInsights – reinvestment', () => {
  // Sold 10 pcs for 1000 CZK net on 2024-01-01; 10 pcs would be worth 10 × 1 USD × 20 = 200 CZK ... use price 5 -> 1000 CZK
  const econ = [real('US0000000001', 'A', '2024-01-01', 10, 1000, 800, 10), real('US0000000001', 'B', '2025-01-01', 10, 2000, 800, 10)];
  const twr: Record<string, number> = { '2024-01-01': 1, '2025-01-01': 1.5, [TODAY]: 3 };
  const twrAt = (d: string) => twr[d];

  it('grows net proceeds by twr(today)/twr(sellDate)', () => {
    const i = computeInsights(ledger(), econ, [], prices(10), fakeConv, TODAY, { twrAt });
    const m = i.missed[0];
    // value today: 20 pcs × 10 USD × 20 CZK = 4000
    expect(m.soldQty).toBe(20);
    expect(m.proceedsCzk).toBe(3000);
    expect(m.valueTodayCzk).toBe(4000);
    expect(m.diffCzk).toBe(1000);
    // 1000 × 3/1 + 2000 × 3/1.5 = 7000
    expect(m.reinvestedValueCzk).toBeCloseTo(7000, 6);
    expect(m.diffReinvestedCzk).toBeCloseTo(-3000, 6);
    expect(i.missedNetCzk).toBe(1000);
    expect(i.missedNetReinvestedCzk).toBeCloseTo(-3000, 6);
    expect(i.missedTotalCzk).toBe(1000);
  });

  it('subtracts sell fees from the reinvested amount', () => {
    const r = real('US0000000001', 'A', '2024-01-01', 10, 1000, 800, 10);
    r.sellFeesCzk = 100;
    const i = computeInsights(ledger(), [r], [], prices(10), fakeConv, TODAY, { twrAt });
    expect(i.missed[0].proceedsCzk).toBe(900);
    expect(i.missed[0].reinvestedValueCzk).toBeCloseTo(2700, 6);
  });

  it('falls back to no growth without twrAt or without an index on the sell date', () => {
    const plain = computeInsights(ledger(), econ, [], prices(10), fakeConv, TODAY);
    expect(plain.missed[0].reinvestedValueCzk).toBe(3000);
    expect(plain.missedNetReinvestedCzk).toBe(plain.missedNetCzk);
    const partial = computeInsights(ledger(), econ, [], prices(10), fakeConv, TODAY, { twrAt: (d) => (d === TODAY ? 3 : undefined) });
    expect(partial.missed[0].reinvestedValueCzk).toBe(3000);
  });

  it('applies the year filter to the reinvestment estimate', () => {
    const i = computeInsights(ledger(), econ, [], prices(10), fakeConv, TODAY, { twrAt, year: 2025 });
    expect(i.missed[0].soldQty).toBe(10);
    expect(i.missed[0].reinvestedValueCzk).toBeCloseTo(4000, 6);
    expect(i.missed[0].diffReinvestedCzk).toBeCloseTo(-2000, 6);
  });
});

describe('yearTaxSummary.filingReason', () => {
  const settings = (profile: Settings['taxProfiles'][number]): Settings => ({ ...defaultSettings(), taxProfiles: { 2024: profile } });
  const sec = securitiesYearReport([], 2024);
  const div = dividendYearReport([], 2024);

  it.each(['OSVC', 'OSVC_PAUSAL', 'EMPLOYEE', 'NO_INCOME'] as const)('is set when the filing obligation is determined (%s)', (situation) => {
    const s = yearTaxSummary(settings({ situation }), sec, div, 0);
    expect(s.mustFile).not.toBeNull();
    expect(typeof s.filingReason).toBe('string');
    expect(s.filingReason!.length).toBeGreaterThan(10);
    expect(s.filingReason).toBe(s.notes[0].text);
  });

  it('differs between a filing and a non-filing outcome', () => {
    const low = yearTaxSummary(settings({ situation: 'NO_INCOME' }), sec, div, 0);
    const high = yearTaxSummary(settings({ situation: 'NO_INCOME' }), sec, div, 60_000);
    expect(low.mustFile).toBe(false);
    expect(low.filingReason).toContain('nemusíte');
    expect(high.mustFile).toBe(true);
    expect(high.filingReason).toContain('musíte podat');
  });
});
