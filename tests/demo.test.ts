import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFifo } from '../src/core/fifo.js';
import { buildLedger } from '../src/core/parsers/index.js';
import { listExportFiles } from '../src/server/store.js';
import { fakeConv } from './helpers.js';

const DIR = join('demo');

async function demoLedger() {
  const files = listExportFiles(DIR).map((p) => ({ name: relative(DIR, p), data: new Uint8Array(readFileSync(p)) }));
  return { files, ledger: await buildLedger(files) };
}

describe('bundled demo data', () => {
  it('contains Degiro and XTB exports that parse without warnings', async () => {
    const { files, ledger } = await demoLedger();
    expect(files.map((f) => f.name.replace(/\\/g, '/')).sort()).toEqual([
      'degiro/Account.csv',
      'degiro/Transactions.csv',
      expect.stringMatching(/^xtb\/CZK_\d+_2023-01-01_\d{4}-\d{2}-\d{2}\.xlsx$/),
    ]);
    expect(ledger.warnings).toEqual([]);
    expect(new Set(ledger.trades.map((t) => t.broker))).toEqual(new Set(['DEGIRO', 'XTB']));
  });

  it('spans more than three years with real instruments and the typical tax situations', async () => {
    const { ledger } = await demoLedger();
    const dates = ledger.trades.map((t) => t.date).sort();
    expect(Date.parse(dates.at(-1)!) - Date.parse(dates[0])).toBeGreaterThan(3 * 365 * 86400000);
    // real ISINs, e.g. Apple, NVIDIA and the Vanguard ETF held at both brokers
    expect(ledger.instruments.get('US0378331005')?.name).toMatch(/APPLE/);
    const vwce = ledger.trades.filter((t) => t.instrumentId === 'IE00BK5BQT80');
    expect(new Set(vwce.map((t) => t.broker))).toEqual(new Set(['DEGIRO', 'XTB']));
    // NVIDIA 10:1 split
    expect(ledger.actions).toEqual([expect.objectContaining({ kind: 'SPLIT', instrumentId: 'US67066G1040', ratio: 10, date: '2024-06-10' })]);
    // dividends with withholding from several countries, incl. Czech ones at XTB
    const divCountries = new Set(ledger.cash.filter((c) => c.kind === 'DIVIDEND').map((c) => ledger.instruments.get(c.instrumentId!)?.country));
    expect([...divCountries].sort()).toEqual(['CZ', 'DE', 'NL', 'US']);
    expect(ledger.cash.some((c) => c.kind === 'INTEREST' && c.broker === 'XTB')).toBe(true);
    expect(ledger.cash.some((c) => c.kind === 'FEE' && c.feeCategory === 'EXCHANGE_CONNECTION')).toBe(true);

    const { realizations, warnings } = runFifo(ledger, fakeConv);
    expect(warnings).toEqual([]);
    // sales both within and after the 3-year time test, with gains and a loss
    expect(realizations.some((r) => r.timeTestPassed)).toBe(true);
    expect(realizations.some((r) => !r.timeTestPassed && r.gainCzk > 0)).toBe(true);
    expect(realizations.some((r) => r.gainCzk < 0)).toBe(true);
  });
});
