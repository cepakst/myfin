import type { Realization } from '../fifo.js';

/** §4(1)(t) – yearly limit of gross proceeds from securities sales that are exempt */
export const SMALL_SALES_LIMIT = 100_000;
/** §4(1)(u) cap on time-test exempt income – applied to securities only in tax year 2025 */
export const EXEMPT_CAP_2025 = 40_000_000;

export function exemptCapApplies(year: number): boolean {
  return year === 2025;
}

/** §38v – exempt income above this amount must be reported to the tax authority */
export const EXEMPT_REPORTING_LIMIT = 5_000_000;

/** Threshold (36× / 48× average wage) above which the 23 % rate applies */
export const HIGH_RATE_THRESHOLD: Record<number, number> = {
  2020: 1_672_080,
  2021: 1_701_168,
  2022: 1_867_728,
  2023: 1_935_552,
  2024: 1_582_812,
  2025: 1_676_052,
  2026: 1_762_812,
};

export function highRateThreshold(year: number): number {
  return HIGH_RATE_THRESHOLD[year] ?? HIGH_RATE_THRESHOLD[Math.max(...Object.keys(HIGH_RATE_THRESHOLD).map(Number))];
}

/** Estimated personal income tax on `base` when `otherBase` is already taxed in the same year */
export function marginalTax(base: number, otherBase: number, year: number): number {
  if (base <= 0) return 0;
  if (year < 2021) return base * 0.15; // super-gross era approximation
  const t = highRateThreshold(year);
  const low = Math.max(0, Math.min(base, t - otherBase));
  return low * 0.15 + (base - low) * 0.23;
}

export interface SecuritiesYearReport {
  year: number;
  realizations: Realization[];
  totalProceedsCzk: number;
  timeTestProceedsCzk: number;
  timeTestGainCzk: number;
  /** Proceeds counted toward the 100k limit (sales not exempt by the time test) */
  limitProceedsCzk: number;
  smallSalesExempt: boolean;
  /** Proceeds above the 40 M cap that lose the time-test exemption */
  capExcessCzk: number;
  taxable: {
    incomeCzk: number;
    expensesCzk: number;
    gainsCzk: number;
    lossesCzk: number;
    resultCzk: number;
    /** Positive part that enters the §10 tax base */
    baseCzk: number;
    count: number;
  };
  exemptGainCzk: number;
  /** Losses from exempt sales – cannot be used */
  exemptLossCzk: number;
  /** Largest single exempt sale (time test) – §38v reporting if above 5 M */
  largestExemptSaleCzk: number;
}

export function securitiesYearReport(all: Realization[], year: number): SecuritiesYearReport {
  const rs = all.filter((r) => Number(r.sellDate.slice(0, 4)) === year);
  const tt = rs.filter((r) => r.timeTestPassed);
  const rest = rs.filter((r) => !r.timeTestPassed);
  const totalProceedsCzk = rs.reduce((s, r) => s + r.proceedsCzk, 0);
  const timeTestProceedsCzk = tt.reduce((s, r) => s + r.proceedsCzk, 0);
  const limitProceedsCzk = rest.reduce((s, r) => s + r.proceedsCzk, 0);
  const smallSalesExempt = limitProceedsCzk <= SMALL_SALES_LIMIT;
  const capExcessCzk = exemptCapApplies(year) ? Math.max(0, timeTestProceedsCzk - EXEMPT_CAP_2025) : 0;

  const taxableRs = smallSalesExempt ? [] : rest;
  let incomeCzk = 0;
  let expensesCzk = 0;
  let gainsCzk = 0;
  let lossesCzk = 0;
  for (const r of taxableRs) {
    incomeCzk += r.proceedsCzk;
    expensesCzk += r.costCzk + r.buyFeesCzk + r.sellFeesCzk;
    if (r.gainCzk >= 0) gainsCzk += r.gainCzk;
    else lossesCzk += -r.gainCzk;
  }
  // 40M cap: the excess part of time-tested proceeds becomes taxable (proportional gain)
  if (capExcessCzk > 0) {
    const share = capExcessCzk / timeTestProceedsCzk;
    for (const r of tt) {
      incomeCzk += r.proceedsCzk * share;
      expensesCzk += (r.costCzk + r.buyFeesCzk + r.sellFeesCzk) * share;
      if (r.gainCzk >= 0) gainsCzk += r.gainCzk * share;
      else lossesCzk += -r.gainCzk * share;
    }
  }
  const resultCzk = incomeCzk - expensesCzk;
  const exempt = smallSalesExempt ? rs : tt;
  const bySale = new Map<string, number>();
  for (const r of tt) bySale.set(r.tradeId, (bySale.get(r.tradeId) ?? 0) + r.proceedsCzk);
  return {
    year,
    realizations: rs,
    totalProceedsCzk,
    timeTestProceedsCzk,
    timeTestGainCzk: tt.reduce((s, r) => s + r.gainCzk, 0),
    limitProceedsCzk,
    smallSalesExempt,
    capExcessCzk,
    taxable: { incomeCzk, expensesCzk, gainsCzk, lossesCzk, resultCzk, baseCzk: Math.max(0, resultCzk), count: taxableRs.length },
    exemptGainCzk: exempt.filter((r) => r.gainCzk > 0).reduce((s, r) => s + r.gainCzk, 0),
    exemptLossCzk: exempt.filter((r) => r.gainCzk < 0).reduce((s, r) => s - r.gainCzk, 0),
    largestExemptSaleCzk: Math.max(0, ...bySale.values()),
  };
}
