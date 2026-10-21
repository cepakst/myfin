import { describe, expect, it } from 'vitest';
import { FxRates, parseCnbYear } from '../src/core/fx.js';

function cnbText(year: number, rate: (month: number, day: number) => number): string {
  const lines = ['Datum|1 USD|100 JPY'];
  for (let m = 1; m <= 12; m++) {
    for (const d of [2, 15, 28]) {
      const r = rate(m, d);
      lines.push(`${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${year}|${r.toFixed(3).replace('.', ',')}|${(r * 10).toFixed(3).replace('.', ',')}`);
    }
  }
  return lines.join('\n');
}

describe('CNB fixings', () => {
  it('parses yearly file with units', () => {
    const f = parseCnbYear('Datum|1 USD|100 JPY\n02.01.2020|22,500|20,000\n');
    expect(f).toEqual([{ date: '2020-01-02', rates: { USD: 22.5, JPY: 0.2 } }]);
  });

  it('parses repeated header lines', () => {
    const f = parseCnbYear('Datum|1 USD\n02.01.2020|22,5\nDatum|1 EUR|1 USD\n03.01.2020|25|23\n');
    expect(f[1].rates).toEqual({ EUR: 25, USD: 23 });
  });
});

describe('FxRates', () => {
  const fx = new FxRates(parseCnbYear(cnbText(2020, (m) => 20 + m)), { methodByYear: { 2021: 'DAILY' }, unifiedOverrides: {} }, {});

  it('returns last fixing on or before the date', () => {
    expect(fx.daily('USD', '2020-03-15')).toBe(23);
    expect(fx.daily('USD', '2020-03-20')).toBe(23);
    expect(fx.daily('USD', '2020-01-01')).toBe(21);
    expect(fx.daily('CZK', '2020-01-01')).toBe(1);
  });

  it('computes unified rate as mean of month-end fixings', () => {
    const u = fx.unified('USD', 2020);
    expect(u.rate).toBe(26.5); // mean of 21..32
    expect(u.source).toBe('computed');
    expect(u.provisional).toBe(false);
  });

  it('marks incomplete years provisional', () => {
    const part = new FxRates(parseCnbYear(cnbText(2020, () => 20).split('\n').slice(0, 10).join('\n')), undefined, {});
    expect(part.unified('USD', 2020).provisional).toBe(true);
  });

  it('prefers manual override and official rates', () => {
    const o = new FxRates(parseCnbYear(cnbText(2020, () => 20)), { methodByYear: {}, unifiedOverrides: { 2020: { USD: 23.14 } } }, { 2020: { USD: 99 } });
    expect(o.unified('USD', 2020)).toMatchObject({ rate: 23.14, source: 'override' });
    const p = new FxRates(parseCnbYear(cnbText(2020, () => 20)), undefined, { 2020: { USD: 23.14 } });
    expect(p.unified('USD', 2020)).toMatchObject({ rate: 23.14, source: 'official' });
  });

  it('switches tax method per year', () => {
    expect(fx.toCzkTax(10, 'USD', '2020-03-15')).toBeCloseTo(265);
    expect(fx.methodFor(2021)).toBe('DAILY');
  });
});
