import ExcelJS from 'exceljs';
import FormulaParser, { type FnArg } from 'fast-formula-parser';
import { describe, expect, it } from 'vitest';
import { runFifo } from '../src/core/fifo.js';
import { FxRates, type CnbFixing } from '../src/core/fx.js';
import { mergeSettings, type Settings } from '../src/core/settings.js';
import { dapDividends, dapSecurities } from '../src/core/tax/dap.js';
import { buildDividendPayments, dividendYearReport } from '../src/core/tax/dividends.js';
import { securitiesYearReport } from '../src/core/tax/securities.js';
import { yearTaxSummary } from '../src/core/tax/summary.js';
import type { CashEvent, Ledger } from '../src/core/types.js';
import type { Snapshot } from '../src/server/engine.js';
import { buildTaxReport, CLASS_TAXABLE, CLASS_TIME_TEST } from '../src/server/taxReport.js';
import { inst, ledgerWith, trade } from './helpers.js';

const YEAR = 2024;

const fixings: CnbFixing[] = [
  '2020-01-03',
  '2023-01-10',
  '2023-02-01',
  '2023-03-10',
  '2024-03-01',
  '2024-04-15',
  '2024-05-02',
  '2024-06-03',
  '2024-07-01',
  '2024-09-02',
].map((date, i) => ({
  date,
  rates: { USD: 22 + i * 0.137, EUR: 24 + i * 0.211 },
}));

let cashSeq = 0;
const cash = (
  kind: CashEvent['kind'],
  date: string,
  amount: number,
  currency: string,
  instrumentId?: string,
  broker: CashEvent['broker'] = 'DEGIRO',
): CashEvent => ({
  id: `C${++cashSeq}`,
  broker,
  kind,
  dateTime: `${date}T08:00:00`,
  date,
  amount,
  currency,
  instrumentId,
  description: `${kind} test`,
});

function syntheticLedger(): Ledger {
  const l = ledgerWith(
    [inst('US0000000001'), inst('DE0000000002', 'EUR'), inst('US0000000003'), inst('CZ0000000004', 'CZK')],
    [
      trade('US0000000001', '2020-01-03', 10, 100, {
        fees: [{ amount: 1, currency: 'EUR' }],
      }),
      trade('US0000000001', '2023-03-10', 10, 150),
      // FIFO: 10 ks from 2020 (time test passed) + 5 ks from 2023
      trade('US0000000001', '2024-06-03', -15, 200, {
        fees: [{ amount: 2, currency: 'EUR' }],
      }),
      trade('DE0000000002', '2023-01-10', 100, 50, {
        currency: 'EUR',
        fees: [{ amount: 1, currency: 'EUR' }],
      }),
      // 6 000 EUR proceeds alone exceed the 100 000 Kč limit
      trade('DE0000000002', '2024-05-02', -100, 60, {
        currency: 'EUR',
        fees: [{ amount: 1, currency: 'EUR' }],
      }),
      // XTB CZK account: settled in CZK by the broker
      trade('US0000000003', '2023-02-01', 5, 100, {
        broker: 'XTB',
        amountCzk: 11_500,
      }),
      trade('US0000000003', '2024-07-01', -5, 120, {
        broker: 'XTB',
        amountCzk: 14_000,
      }),
    ],
  );
  l.cash.push(
    cash('DIVIDEND', '2024-03-01', 100, 'USD', 'US0000000001'),
    cash('DIVIDEND_TAX', '2024-03-01', -15, 'USD', 'US0000000001'),
    cash('DIVIDEND', '2024-04-15', 100, 'EUR', 'DE0000000002'),
    cash('DIVIDEND_TAX', '2024-04-15', -26.375, 'EUR', 'DE0000000002'),
    cash('DIVIDEND', '2024-09-02', 1000, 'CZK', 'CZ0000000004', 'XTB'),
    cash('DIVIDEND_TAX', '2024-09-02', -150, 'CZK', 'CZ0000000004', 'XTB'),
    cash('INTEREST', '2024-09-02', 10, 'EUR'),
  );
  return l;
}

/** Mirrors the tax part of engine.computeSnapshot for a single year */
function inputFor(settings: Settings) {
  const ledger = syntheticLedger();
  const fx = new FxRates(fixings, settings.fx);
  const conv = (a: number, c: string, d: string) => fx.toCzkTax(a, c, d);
  const rs = runFifo(ledger, conv).realizations;
  const pays = buildDividendPayments(ledger, conv, conv);
  const sec = securitiesYearReport(rs, YEAR);
  const div = dividendYearReport(pays, YEAR);
  const otherCapital = conv(10, 'EUR', '2024-09-02');
  const sum = yearTaxSummary(settings, sec, div, otherCapital);
  const blocks = [
    dapSecurities(sec),
    ...dapDividends(div, YEAR, {
      use16a: sum.use16a,
      generalBaseCzk: sum.generalBaseCzk,
      otherCapitalCzk: otherCapital,
    }),
  ];
  const { realizations: _r, ...secRest } = sec;
  const snapshot = {
    years: [YEAR],
    demo: false,
    files: ['C:/exports/degiro/Transactions.csv'],
    realizations: rs.map((r) => ({ ...r, name: r.instrumentId })),
    securities: [secRest],
    dividends: pays,
    taxSummaries: [sum],
    dap: [{ year: YEAR, blocks }],
  } as unknown as Snapshot;
  return { year: YEAR, snapshot, ledger, fx, settings, blocks, sec };
}

/** Recalculates every formula of the workbook and returns a value getter */
function evaluator(wb: ExcelJS.Workbook) {
  const memo = new Map<string, unknown>();
  const raw = (sheet: string, row: number, col: number): unknown => {
    const key = `${sheet}!${row}:${col}`;
    if (memo.has(key)) return memo.get(key);
    const ws = wb.getWorksheet(sheet);
    if (!ws) throw new Error(`no sheet ${sheet}`);
    const v = ws.getCell(row, col).value;
    let out: unknown = v;
    if (v && typeof v === 'object' && 'formula' in v)
      out = makeParser().parse((v as { formula: string }).formula, {
        sheet,
        row,
        col,
      });
    else if (v instanceof Date) out = v.getTime();
    else if (v == null) out = null;
    memo.set(key, out);
    return out;
  };
  const flat = (args: FnArg[]) => args.flatMap((a) => (Array.isArray(a.value) ? (a.value as unknown[][]).flat() : [a.value]));
  const nums = (args: FnArg[]) => flat(args).filter((x): x is number => typeof x === 'number');
  const matches = (v: unknown, crit: unknown) => {
    if (typeof crit === 'string') {
      const m = /^(>=|<=|<>|>|<|=)(-?\d+(?:\.\d+)?)$/.exec(crit);
      if (m && typeof v === 'number') {
        const n = Number(m[2]);
        return {
          '>': v > n,
          '<': v < n,
          '>=': v >= n,
          '<=': v <= n,
          '=': v === n,
          '<>': v !== n,
        }[m[1]]!;
      }
    }
    return v === crit;
  };
  const ifs = (sumRange: unknown[] | null, pairs: FnArg[]) => {
    const conds = [];
    for (let i = 0; i < pairs.length; i += 2)
      conds.push({
        range: (pairs[i].value as unknown[][]).flat(),
        crit: pairs[i + 1].value,
      });
    const n = conds[0].range.length;
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!conds.every((c) => matches(c.range[i], c.crit))) continue;
      total += sumRange ? (typeof sumRange[i] === 'number' ? (sumRange[i] as number) : 0) : 1;
    }
    return total;
  };
  // the parser keeps lexer state, so nested evaluation (a formula reading another formula) needs its own instance
  const makeParser = (): FormulaParser =>
    new FormulaParser({
      onCell: ({ sheet, row, col }) => raw(sheet, row, col),
      onRange: ({ sheet, from, to }) => {
        const out: unknown[][] = [];
        for (let r = from.row; r <= to.row; r++) {
          const line: unknown[] = [];
          for (let c = from.col; c <= to.col; c++) line.push(raw(sheet, r, c));
          out.push(line);
        }
        return out;
      },
      functions: {
        SUM: (...a) => nums(a).reduce((x, y) => x + y, 0),
        MIN: (...a) => Math.min(...nums(a)),
        MAX: (...a) => Math.max(...nums(a)),
        SUMIFS: (sum, ...pairs) => ifs((sum.value as unknown[][]).flat(), pairs),
        COUNTIFS: (...pairs) => ifs(null, pairs),
      },
    });
  return raw;
}

async function generate(settings: Settings) {
  const input = inputFor(settings);
  const buf = await buildTaxReport(input);
  const wb = new ExcelJS.Workbook();
  // ExcelJS typings expect a Node Buffer
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return { ...input, wb, value: evaluator(wb) };
}

/** Column B value of the Souhrn row whose label starts with `prefix` (recalculated) */
function summaryValue(wb: ExcelJS.Workbook, value: (s: string, r: number, c: number) => unknown, prefix: string): unknown {
  const ws = wb.getWorksheet('Souhrn')!;
  for (let r = 1; r <= ws.rowCount; r++) if (String(ws.getCell(r, 1).value ?? '').startsWith(prefix)) return value('Souhrn', r, 2);
  throw new Error(`row ${prefix} not found`);
}

const dapValue = (blocks: ReturnType<typeof inputFor>['blocks'], row: string) => blocks.flatMap((b) => b.fields).find((f) => f.row === row)?.value;

describe('tax report workbook', () => {
  it('every formula recalculates to the value the app computed', async () => {
    const { wb, value } = await generate(mergeSettings({}));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Souhrn', 'Prodeje CP', 'Dividendy', 'Úroky', 'Kurzy', 'DAP']);
    let formulas = 0;
    for (const ws of wb.worksheets)
      ws.eachRow((row, r) =>
        row.eachCell((cell, c) => {
          const v = cell.value as { formula?: string; result?: unknown } | null;
          if (!v || typeof v !== 'object' || !('formula' in v)) return;
          formulas++;
          const got = value(ws.name, r, c);
          // ExcelJS drops a cached result of 0 when reading; Excel recalculates on load anyway
          if (v.result === undefined) expect(got, `${ws.name}!${cell.address} ${v.formula}`).toBe(0);
          else if (typeof v.result === 'number') expect(got, `${ws.name}!${cell.address} ${v.formula}`).toBeCloseTo(v.result, 6);
          else expect(got, `${ws.name}!${cell.address} ${v.formula}`).toBe(v.result);
        }),
      );
    expect(formulas).toBeGreaterThan(40);
  });

  it('derives the tax return rows by formulas that match the app (unified rate, §16a)', async () => {
    const { wb, value, blocks, sec } = await generate(mergeSettings({}));
    expect(sec.smallSalesExempt).toBe(false);
    for (const row of ['207', '208', '209', '401a', '409', '410', '411', '412', '413', '414'])
      expect(summaryValue(wb, value, `ř. ${row} `), `ř. ${row}`).toBe(dapValue(blocks, row));

    const sales = wb.getWorksheet('Prodeje CP')!;
    const header = sales.getRow(4).values as unknown[];
    const classCol = header.indexOf('Daňové zařazení');
    const classes = [5, 6, 7, 8].map((r) => sales.getCell(r, classCol).value);
    expect(classes.filter((c) => c === CLASS_TIME_TEST)).toHaveLength(1);
    expect(classes.filter((c) => c === CLASS_TAXABLE)).toHaveLength(3);
    // rates: official unified rates for USD/EUR and the XTB settlement rate
    const fxRows = wb
      .getWorksheet('Kurzy')!
      .getSheetValues()
      .map((r) => (Array.isArray(r) ? r.slice(1, 5).join('|') : ''));
    expect(fxRows).toEqual(
      expect.arrayContaining(['USD|jednotný kurz|2024|23.28', 'EUR|jednotný kurz|2023|23.97', 'USD|kurz vypořádání brokera|2024-07-01|23.333333']),
    );
    // Czech dividend is listed but not part of the foreign total
    expect(summaryValue(wb, value, 'České dividendy')).toBeCloseTo(1000, 6);
    expect(summaryValue(wb, value, 'Úroky bez srážkové daně')).toBeCloseTo(10 * 25.16, 6);
  });

  it('uses daily CNB rates and the general base when selected', async () => {
    const settings = mergeSettings({
      fx: { methodByYear: { [YEAR]: 'DAILY' }, unifiedOverrides: {} },
      taxProfiles: { [YEAR]: { foreign16a: false } },
    });
    const { wb, value, blocks } = await generate(settings);
    for (const row of ['207', '208', '209']) expect(summaryValue(wb, value, `ř. ${row} `)).toBe(dapValue(blocks, row));
    expect(() => summaryValue(wb, value, 'ř. 414 ')).toThrow();
    const fxRows = wb
      .getWorksheet('Kurzy')!
      .getSheetValues()
      .map((r) => (Array.isArray(r) ? r.slice(1, 4).join('|') : ''));
    expect(fxRows).toEqual(expect.arrayContaining(['USD|denní kurz ČNB|2024-06-03', 'EUR|jednotný kurz|2023']));
  });
});
