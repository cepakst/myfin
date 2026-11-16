import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarizeAccounts, defaultAccountsConfig } from '../src/core/accounts/analytics.js';
import { bankTxsFromTable, detectBankKind, readBankTables } from '../src/core/accounts/bankTables.js';
import { buildBankLedger } from '../src/core/accounts/ledger.js';
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
    const investment = files.map((f) => f.name.replace(/\\/g, '/')).filter((n) => /^(degiro|xtb)\//.test(n)).sort();
    expect(investment).toEqual([
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

describe('bundled demo bank statements', () => {
  const norm = (n: string) => n.split('\\').join('/');
  const bankFiles = async () => (await demoLedger()).files.filter((f) => /^(fio|kb|rb)\//.test(norm(f.name)));
  const FIO = '2101234567/2010';
  const KB = '19-2000145398/0100';
  const RB = '1234567890/5500';
  const RBS = '1234567891/5500';
  const summary = async () => {
    const ledger = buildBankLedger(await bankFiles());
    return { ledger, s: summarizeAccounts(ledger, defaultAccountsConfig(), '2026-10-24', (a, c) => (c === 'CZK' ? a : null)) };
  };

  it('contains Fio (monthly), KB (yearly) and Raiffeisenbank (two accounts) statements that are detected and parse without warnings', async () => {
    const files = await bankFiles();
    const by = (dir: string) => files.filter((f) => norm(f.name).startsWith(`${dir}/`));
    expect(by('fio').length).toBeGreaterThanOrEqual(36);
    expect(by('kb').length).toBeGreaterThanOrEqual(3);
    expect(by('rb')).toHaveLength(2);
    for (const f of files) expect(detectBankKind(f.name, f.data), f.name).toBe(({ fio: 'BANK_FIO', kb: 'BANK_KB', rb: 'BANK_RB' } as const)[norm(f.name).split('/')[0] as 'fio']);
    const { ledger } = await summary();
    expect(ledger.warnings).toEqual([]);
    expect([...ledger.accounts.keys()].sort()).toEqual([RB, RBS, FIO, KB].sort());
    expect(ledger.txs.length).toBeGreaterThan(1000);
  });

  it('every Fio and KB statement is internally consistent: opening + movements = closing', async () => {
    let checked = 0;
    for (const f of (await bankFiles()).filter((x) => !norm(x.name).startsWith('rb/'))) {
      for (const t of readBankTables(f.name, f.data)) {
        const [open, close] = t.balances!;
        const moved = bankTxsFromTable(t).txs.reduce((s, x) => s + x.amount, 0);
        expect(Math.round((open.balance + moved) * 100) / 100, f.name).toBe(close.balance);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  it('statement balances chain without a mismatch; only the two RB accounts lack a stated balance', async () => {
    const { s } = await summary();
    expect(s.warnings.filter((w) => w.message.includes('nesedí'))).toEqual([]);
    expect(s.warnings.filter((w) => w.message.includes('neobsahuje zůstatek')).length).toBe(2);
    expect(s.warnings).toHaveLength(2);
    for (const id of [FIO, KB]) expect(s.accounts.find((a) => a.id === id)!.anchored).toBe(true);
    for (const id of [RB, RBS]) expect(s.accounts.find((a) => a.id === id)!.anchored).toBe(false);
    expect(s.accounts.filter((a) => a.product === 'savings').map((a) => a.id).sort()).toEqual([FIO, RBS].sort());
    expect(s.accounts.find((a) => a.id === RBS)!.product).toBe('savings');
    expect(s.accounts.find((a) => a.id === RB)!.product).toBe('current');
    expect(s.accounts.find((a) => a.id === KB)!.product).toBe('current');
  });

  it('transfers between KB, RB, Fio and the RB savings account are detected', async () => {
    const { s } = await summary();
    const transfers = s.txs.filter((t) => t.flow === 'transfer');
    const pair = (a: string, b: string) => transfers.filter((t) => t.accountId === a && t.otherAccount === b).length;
    expect(pair(KB, RB)).toBeGreaterThan(30);
    expect(pair(RB, KB)).toBe(pair(KB, RB));
    expect(pair(KB, FIO)).toBeGreaterThan(30);
    expect(pair(FIO, KB)).toBe(pair(KB, FIO));
    // the "Inteligentní spoření" sweep has the savings account as counterparty
    expect(pair(RB, RBS)).toBeGreaterThan(30);
    expect(pair(RBS, RB)).toBe(pair(RB, RBS));
    // no card payment or salary is mistaken for a transfer
    expect(transfers.every((t) => t.otherAccount || /spoření/i.test(t.bankType))).toBe(true);
    expect(s.txs.filter((t) => t.flow === 'income' && /MZDA/.test(t.message ?? '')).length).toBeGreaterThan(30);
  });

  it('XTB deposits are classified as investments', async () => {
    const { s } = await summary();
    const xtb = s.txs.filter((t) => /XTB/.test(t.cpName ?? ''));
    expect(xtb.length).toBeGreaterThan(30);
    expect(xtb.every((t) => t.flow === 'investment')).toBe(true);
    expect(s.totals.invested12m).toBeGreaterThan(0);
  });

  it('Degiro deposits are classified as investments', async () => {
    const { s } = await summary();
    const degiro = s.txs.filter((t) => /DEGIRO/i.test(t.cpName ?? ''));
    expect(degiro.length).toBeGreaterThan(30);
    expect(degiro.every((t) => t.flow === 'investment')).toBe(true);
  });

  it('the household totals are plausible', async () => {
    const { s } = await summary();
    expect(s.totals.balanceCzk).toBeGreaterThan(0);
    expect(s.totals.income12m).toBeGreaterThan(s.totals.expense12m);
    expect(s.totals.savingsRate12m!).toBeGreaterThan(0);
    expect(s.totals.savingsRate12m!).toBeLessThan(1);
    expect(s.accounts.every((a) => a.balanceCzk !== null)).toBe(true);
  });
});
