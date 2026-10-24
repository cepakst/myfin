import { describe, expect, it } from 'vitest';
import { summarizeByInstrument } from '../src/web/pages/Dividends.js';

type Pays = Parameters<typeof summarizeByInstrument>[0];

const pay = (o: Record<string, unknown>) =>
  ({ instrumentId: 'US1', name: 'ACME', country: 'US', grossCzk: 100, withheldCzk: 15, netCzk: 85, creditableCzk: 15, dueCzk: 0, reclaimableCzk: 0, finalTaxed: false, ...o }) as unknown as Pays[number];

describe('summarizeByInstrument', () => {
  it('returns nothing for no payments', () => {
    expect(summarizeByInstrument([])).toEqual([]);
  });

  it('aggregates payments per instrument', () => {
    const r = summarizeByInstrument([
      pay({ dueCzk: 1 }),
      pay({ grossCzk: 200, withheldCzk: 30, netCzk: 170, creditableCzk: 20, dueCzk: 2, reclaimableCzk: 10 }),
      pay({ instrumentId: 'FR1', name: 'BETA', country: 'FR', grossCzk: 50, withheldCzk: 0, netCzk: 50, creditableCzk: 0, dueCzk: 7.5 }),
    ]);
    expect(r).toHaveLength(2);
    const us = r.find((x) => x.instrumentId === 'US1')!;
    expect(us).toMatchObject({ name: 'ACME', country: 'US', count: 2, grossCzk: 300, withheldCzk: 45, netCzk: 255, creditableCzk: 35, dueCzk: 3, reclaimableCzk: 10 });
    expect(us.withheldRate).toBeCloseTo(0.15, 10);
    const fr = r.find((x) => x.instrumentId === 'FR1')!;
    expect(fr).toMatchObject({ count: 1, grossCzk: 50, dueCzk: 7.5 });
    expect(fr.withheldRate).toBe(0);
  });

  it('excludes final-taxed payments from the amount due and gives null rate for zero gross', () => {
    const r = summarizeByInstrument([pay({ finalTaxed: true, dueCzk: 99 }), pay({ instrumentId: 'Z', grossCzk: 0, withheldCzk: 0 })]);
    expect(r.find((x) => x.instrumentId === 'US1')!.dueCzk).toBe(0);
    expect(r.find((x) => x.instrumentId === 'Z')!.withheldRate).toBeNull();
  });
});
