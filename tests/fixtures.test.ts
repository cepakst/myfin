import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLedger } from '../src/core/parsers/index.js';

const DIR = join('tests', 'e2e', 'fixtures', 'degiro');

describe('E2E fixtures', () => {
  it('parse into the expected synthetic ledger', async () => {
    const files = readdirSync(DIR).map((name) => ({ name, data: new Uint8Array(readFileSync(join(DIR, name))) }));
    const l = await buildLedger(files);
    expect(l.warnings).toEqual([]);
    const key = (t: { date: string; instrumentId: string; quantity: number }) => [t.date, t.instrumentId, t.quantity];
    const gama = l.trades.filter((t) => t.instrumentId === 'US0000000007');
    expect(l.trades.filter((t) => t.instrumentId !== 'US0000000007').map(key)).toEqual([
      ['2020-01-05', 'US0000000001', 10],
      ['2023-03-10', 'US0000000004', 20],
      ['2024-02-15', 'US0000000001', -4],
      ['2024-09-20', 'US0000000004', -20],
    ]);
    // GAMA: one buy of 30 and 30 single-share sales in early 2022 – enough rows for the scrolling E2E test
    expect(gama.map((t) => t.quantity)).toEqual([30, ...Array<number>(30).fill(-1)]);
    expect(gama.every((t) => t.date.startsWith('2022-'))).toBe(true);
    expect(l.cash.filter((c) => c.kind === 'DIVIDEND')).toHaveLength(2);
    expect(l.cash.filter((c) => c.kind === 'DIVIDEND_TAX')).toHaveLength(2);
  });
});
