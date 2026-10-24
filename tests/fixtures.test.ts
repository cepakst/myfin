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
    expect(l.trades.map((t) => [t.date, t.instrumentId, t.quantity])).toEqual([
      ['2020-01-05', 'US0000000001', 10],
      ['2023-03-10', 'US0000000004', 20],
      ['2024-02-15', 'US0000000001', -4],
      ['2024-09-20', 'US0000000004', -20],
    ]);
    expect(l.cash.filter((c) => c.kind === 'DIVIDEND')).toHaveLength(2);
    expect(l.cash.filter((c) => c.kind === 'DIVIDEND_TAX')).toHaveLength(2);
  });
});
