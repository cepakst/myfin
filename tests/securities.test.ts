import { describe, expect, it } from 'vitest';
import type { Realization } from '../src/core/fifo.js';
import { marginalTax, securitiesYearReport } from '../src/core/tax/securities.js';

function real(sellDate: string, proceedsCzk: number, costCzk: number, timeTestPassed = false): Realization {
  return {
    id: `${sellDate}-${proceedsCzk}`,
    broker: 'DEGIRO',
    instrumentId: 'X',
    tradeId: 't',
    lotId: 'L',
    sellDate,
    sellDateTime: `${sellDate}T10:00:00`,
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

describe('securities §10 report', () => {
  it('exempts everything when non-time-tested proceeds are ≤ 100 000 CZK', () => {
    const r = securitiesYearReport([real('2024-03-01', 60_000, 40_000), real('2024-05-01', 40_000, 10_000)], 2024);
    expect(r.limitProceedsCzk).toBe(100_000);
    expect(r.smallSalesExempt).toBe(true);
    expect(r.taxable.baseCzk).toBe(0);
    expect(r.exemptGainCzk).toBe(50_000);
  });

  it('taxes all non-time-tested sales above the limit and nets losses', () => {
    const r = securitiesYearReport([real('2024-03-01', 80_000, 50_000), real('2024-05-01', 30_000, 40_000), real('2023-05-01', 999_999, 0)], 2024);
    expect(r.smallSalesExempt).toBe(false);
    expect(r.taxable.incomeCzk).toBe(110_000);
    expect(r.taxable.expensesCzk).toBe(90_000);
    expect(r.taxable.gainsCzk).toBe(30_000);
    expect(r.taxable.lossesCzk).toBe(10_000);
    expect(r.taxable.baseCzk).toBe(20_000);
  });

  it('excludes time-tested sales from the limit and from the base', () => {
    const r = securitiesYearReport([real('2024-03-01', 90_000, 50_000), real('2024-05-01', 500_000, 100_000, true)], 2024);
    expect(r.limitProceedsCzk).toBe(90_000);
    expect(r.smallSalesExempt).toBe(true);
    expect(r.timeTestGainCzk).toBe(400_000);
    expect(r.taxable.baseCzk).toBe(0);
  });

  it('never produces a negative base', () => {
    const r = securitiesYearReport([real('2024-03-01', 200_000, 300_000)], 2024);
    expect(r.taxable.resultCzk).toBe(-100_000);
    expect(r.taxable.baseCzk).toBe(0);
  });

  it('applies the 40 M cap on time-tested proceeds only in 2025', () => {
    const r = securitiesYearReport([real('2025-03-01', 50_000_000, 10_000_000, true)], 2025);
    expect(r.capExcessCzk).toBe(10_000_000);
    expect(r.taxable.incomeCzk).toBeCloseTo(10_000_000);
    expect(r.taxable.baseCzk).toBeCloseTo(8_000_000);
    const r24 = securitiesYearReport([real('2024-03-01', 50_000_000, 10_000_000, true)], 2024);
    expect(r24.capExcessCzk).toBe(0);
    const r26 = securitiesYearReport([real('2026-03-01', 50_000_000, 10_000_000, true)], 2026);
    expect(r26.capExcessCzk).toBe(0);
    expect(r26.taxable.baseCzk).toBe(0);
  });
});

describe('marginal tax', () => {
  it('splits between 15 % and 23 %', () => {
    expect(marginalTax(100_000, 0, 2024)).toBeCloseTo(15_000);
    const t = marginalTax(200_000, 1_482_812, 2024); // 100k below the 2024 threshold
    expect(t).toBeCloseTo(100_000 * 0.15 + 100_000 * 0.23);
    expect(marginalTax(-5, 0, 2024)).toBe(0);
  });
});
