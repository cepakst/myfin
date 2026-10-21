import { pad2, todayIso, yearOf } from './util.js';

/** One CNB daily fixing: CZK per 1 unit of currency */
export interface CnbFixing {
  date: string;
  rates: Record<string, number>;
}

/**
 * Parses CNB yearly file
 * https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok=YYYY
 * Header lines ("Datum|1 AUD|...") may repeat when the currency list changes.
 */
export function parseCnbYear(text: string): CnbFixing[] {
  const out: CnbFixing[] = [];
  let header: { cur: string; units: number }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|');
    if (/^Datum/i.test(parts[0])) {
      header = parts.slice(1).map((p) => {
        const [u, c] = p.trim().split(/\s+/);
        return { cur: c.toUpperCase(), units: Number(u) };
      });
      continue;
    }
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(parts[0]);
    if (!m) continue;
    const rates: Record<string, number> = {};
    parts.slice(1).forEach((p, i) => {
      const h = header[i];
      if (!h) return;
      const v = Number(p.replace(',', '.'));
      if (Number.isFinite(v) && v > 0) rates[h.cur] = v / h.units;
    });
    out.push({ date: `${m[3]}-${m[2]}-${m[1]}`, rates });
  }
  return out;
}

export type FxMethod = 'UNIFIED' | 'DAILY';

export interface FxConfig {
  /** Method per tax year; default UNIFIED */
  methodByYear: Record<number, FxMethod>;
  /** Manual unified rates per year (e.g. official GFŘ values) */
  unifiedOverrides: Record<number, Record<string, number>>;
}

/**
 * Official "jednotný kurz" published by GFŘ (CZK per 1 unit).
 * Used in preference to the computed value whenever available.
 * 2025 USD/GBP are left to the computed value until verified against the GFŘ publication.
 */
export const OFFICIAL_UNIFIED_RATES: Record<number, Record<string, number>> = {
  2020: { EUR: 26.5, USD: 23.14, GBP: 29.8, SEK: 2.53, DKK: 3.55, CHF: 24.74, PLN: 5.93 },
  2021: { EUR: 25.65, USD: 21.72, GBP: 29.88, SEK: 2.53, DKK: 3.45, CHF: 23.76, PLN: 5.61 },
  2022: { EUR: 24.54, USD: 23.41, GBP: 28.72, SEK: 2.3, DKK: 3.3, CHF: 24.51, PLN: 5.24 },
  2023: { EUR: 23.97, USD: 22.14, GBP: 27.59, SEK: 2.09, DKK: 3.22, CHF: 24.69, PLN: 5.31 },
  2024: { EUR: 25.16, USD: 23.28, GBP: 29.78, SEK: 2.2, DKK: 3.37, CHF: 26.4, PLN: 5.85 },
  2025: { EUR: 24.66, SEK: 2.23, DKK: 3.3, CHF: 26.33, PLN: 5.82 },
};

export class FxRates {
  private series = new Map<string, { dates: string[]; rates: number[] }>();
  private unifiedCache = new Map<string, { rate: number; provisional: boolean; source: 'official' | 'override' | 'computed' }>();
  readonly lastDate: string;
  readonly firstDate: string;

  constructor(
    fixings: CnbFixing[],
    private config: FxConfig = { methodByYear: {}, unifiedOverrides: {} },
    private officialUnified: Record<number, Record<string, number>> = OFFICIAL_UNIFIED_RATES,
  ) {
    const sorted = [...fixings].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const f of sorted) {
      for (const [cur, rate] of Object.entries(f.rates)) {
        let s = this.series.get(cur);
        if (!s) {
          s = { dates: [], rates: [] };
          this.series.set(cur, s);
        }
        s.dates.push(f.date);
        s.rates.push(rate);
      }
    }
    this.firstDate = sorted[0]?.date ?? '';
    this.lastDate = sorted[sorted.length - 1]?.date ?? '';
  }

  hasCurrency(cur: string): boolean {
    return cur === 'CZK' || this.series.has(cur);
  }

  currencies(): string[] {
    return [...this.series.keys()].sort();
  }

  /** CNB rate valid on the given date (last fixing on or before the date). */
  daily(cur: string, date: string): number {
    if (cur === 'CZK') return 1;
    const s = this.series.get(cur);
    if (!s || s.dates.length === 0) throw new Error(`Chybí kurz ČNB pro měnu ${cur}`);
    let lo = 0;
    let hi = s.dates.length - 1;
    if (date < s.dates[0]) return s.rates[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s.dates[mid] <= date) lo = mid;
      else hi = mid - 1;
    }
    return s.rates[lo];
  }

  /**
   * Unified rate for a year: official GFŘ value, manual override, or computed as the
   * arithmetic mean of CNB rates on the last fixing day of each month (provisional for incomplete years).
   */
  unified(cur: string, year: number): { rate: number; provisional: boolean; source: 'official' | 'override' | 'computed' } {
    if (cur === 'CZK') return { rate: 1, provisional: false, source: 'official' };
    const key = `${cur}|${year}`;
    const cached = this.unifiedCache.get(key);
    if (cached) return cached;
    let res: { rate: number; provisional: boolean; source: 'official' | 'override' | 'computed' };
    const ov = this.config.unifiedOverrides[year]?.[cur];
    const off = this.officialUnified[year]?.[cur];
    if (ov && ov > 0) res = { rate: ov, provisional: false, source: 'override' };
    else if (off && off > 0) res = { rate: off, provisional: false, source: 'official' };
    else {
      const s = this.series.get(cur);
      if (!s) throw new Error(`Chybí kurz ČNB pro měnu ${cur}`);
      const monthEnds: number[] = [];
      for (let m = 1; m <= 12; m++) {
        const prefix = `${year}-${pad2(m)}`;
        let idx = -1;
        for (let i = 0; i < s.dates.length; i++) {
          if (s.dates[i].startsWith(prefix)) idx = i;
          else if (s.dates[i] > prefix + '-31') break;
        }
        if (idx >= 0) monthEnds.push(s.rates[idx]);
      }
      if (monthEnds.length === 0) {
        res = { rate: this.daily(cur, `${year}-12-31`), provisional: true, source: 'computed' };
      } else {
        const avg = monthEnds.reduce((a, b) => a + b, 0) / monthEnds.length;
        const yearFinished = todayIso() > `${year}-12-31`;
        res = { rate: Math.round(avg * 100) / 100, provisional: !(monthEnds.length === 12 && yearFinished), source: 'computed' };
      }
    }
    this.unifiedCache.set(key, res);
    return res;
  }

  methodFor(year: number): FxMethod {
    return this.config.methodByYear[year] ?? 'UNIFIED';
  }

  /** Converts using the tax method configured for the year of `date`. */
  taxRate(cur: string, date: string): number {
    if (cur === 'CZK') return 1;
    const y = yearOf(date);
    return this.methodFor(y) === 'DAILY' ? this.daily(cur, date) : this.unified(cur, y).rate;
  }

  toCzkTax(amount: number, cur: string, date: string): number {
    return amount * this.taxRate(cur, date);
  }

  toCzkDaily(amount: number, cur: string, date: string): number {
    return amount * this.daily(cur, date);
  }
}
