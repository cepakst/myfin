import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { xirr } from '../src/core/analytics/performance.js';
import { parseDegiroAccount, parseDegiroTransactions } from '../src/core/parsers/degiro.js';
import { parseXtbXlsx } from '../src/core/parsers/xtb.js';
import { emptyLedger } from '../src/core/types.js';

const TX_HEADER =
  'Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID';

describe('Degiro parser', () => {
  it('parses trades, fees and corporate actions', () => {
    const csv = [
      TX_HEADER,
      '05-01-2021,15:30,ACME CORP,US0000000001,NDQ,XNAS,10,"100,00",USD,"-1000,00",USD,"-820,00","1,22","-2,05","-1,00","-823,05",ord-1',
      '10-06-2022,07:00,ACME CORP,US0000000001,NDQ,,-10,"0,00",USD,"0,00",USD,"0,00",,,,"0,00",',
      '10-06-2022,07:00,ACME CORP,US0000000001,NDQ,,40,"0,00",USD,"0,00",USD,"0,00",,,,"0,00",',
      '01-03-2023,07:00,OLD CO,US0000000002,NDQ,,-5,"0,00",USD,"0,00",USD,"0,00",,,,"0,00",',
      '01-03-2023,07:00,NEW CO,US0000000003,NDQ,,10,"0,00",USD,"0,00",USD,"0,00",,,,"0,00",',
    ].join('\n');
    const l = emptyLedger();
    parseDegiroTransactions(csv, l);
    expect(l.trades).toHaveLength(1);
    const t = l.trades[0];
    expect(t).toMatchObject({ date: '2021-01-05', quantity: 10, price: 100, currency: 'USD', amount: 1000, orderId: 'ord-1' });
    expect(t.fees).toEqual([
      { amount: 1, currency: 'EUR' },
      { amount: 2.05, currency: 'EUR' },
    ]);
    expect(l.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'SPLIT', instrumentId: 'US0000000001', ratio: 4 }),
        expect.objectContaining({ kind: 'CONVERSION', fromId: 'US0000000002', toId: 'US0000000003', ratio: 2 }),
      ]),
    );
  });

  it('parses dividends, withholding, fees and nets reversals', () => {
    const csv = [
      'Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id',
      '15-03-2024,08:00,14-03-2024,ACME CORP,US0000000001,Dividend,,USD,"10,00",USD,"10,00",',
      '15-03-2024,08:00,14-03-2024,ACME CORP,US0000000001,Dividend Tax,,USD,"-1,50",USD,"8,50",',
      '16-03-2024,08:00,14-03-2024,ACME CORP,US0000000001,Dividend,,USD,"-10,00",USD,"-1,50",',
      '16-03-2024,08:00,14-03-2024,ACME CORP,US0000000001,Dividend,,USD,"12,00",USD,"10,50",',
      '01-04-2024,08:00,01-04-2024,,,DEGIRO Exchange Connection Fee 2024 (Nasdaq),,EUR,"-2,50",EUR,"0,00",',
      '02-04-2024,08:00,02-04-2024,,,Deposit,,EUR,"1000,00",EUR,"1000,00",',
      '03-04-2024,08:00,03-04-2024,,,Something unexpected,,EUR,"1,00",EUR,"1000,00",',
    ].join('\n');
    const l = emptyLedger();
    parseDegiroAccount(csv, l);
    const div = l.cash.filter((c) => c.kind === 'DIVIDEND');
    expect(div).toHaveLength(1);
    expect(div[0]).toMatchObject({ amount: 12, date: '2024-03-14', currency: 'USD' });
    expect(l.cash.find((c) => c.kind === 'DIVIDEND_TAX')?.amount).toBe(-1.5);
    expect(l.cash.find((c) => c.kind === 'FEE')).toMatchObject({ amount: -2.5, feeCategory: 'EXCHANGE_CONNECTION' });
    expect(l.cash.find((c) => c.kind === 'DEPOSIT')?.amount).toBe(1000);
    expect(l.warnings).toHaveLength(1);
  });

  it('rejects unknown header', () => {
    expect(() => parseDegiroTransactions('foo,bar\n1,2', emptyLedger())).toThrow();
  });
});

describe('XTB parser', () => {
  it('parses cash operations sheet', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Cash Operations');
    ws.addRow(['Account', '12345']);
    ws.addRow(['Type', 'Instrument', 'Ticker', 'Category', 'Time', 'Amount', 'ID', 'Comment']);
    ws.addRow(['Stock purchase', 'Acme', 'ACME.US', 'STOCK', new Date(Date.UTC(2024, 0, 10, 14, 0)), -2300, '1', 'OPEN BUY 5 @ 20.00']);
    ws.addRow(['Stock sale', 'Acme', 'ACME.US', 'STOCK', new Date(Date.UTC(2024, 5, 10, 14, 0)), 1500, '2', 'CLOSE BUY 3/5 @ 25.00']);
    ws.addRow(['DIVIDENT', 'Acme', 'ACME.US', 'STOCK', new Date(Date.UTC(2024, 3, 1, 14, 0)), 46, '3', 'ACME.US USD 0.4000/ SHR']);
    ws.addRow(['Withholding Tax', 'Acme', 'ACME.US', 'STOCK', new Date(Date.UTC(2024, 3, 1, 14, 0)), -6.9, '4', 'ACME.US USD WHT 15%']);
    ws.addRow(['Free-funds Interest', '', '', '', new Date(Date.UTC(2024, 4, 1, 0, 0)), 12.5, '5', 'Free-funds Interest']);
    ws.addRow(['Deposit', '', '', '', new Date(Date.UTC(2024, 0, 2, 0, 0)), 10000, '6', 'deposit']);
    ws.addRow(['Total', '', '', '', '', 1, '', '']);
    const buf = await wb.xlsx.writeBuffer();
    const l = emptyLedger();
    await parseXtbXlsx(new Uint8Array(buf as ArrayBuffer), l, 'CZK_12345_2024.xlsx');
    expect(l.warnings).toEqual([]);
    expect(l.trades).toHaveLength(2);
    expect(l.trades[0]).toMatchObject({ quantity: 5, price: 20, currency: 'USD', amount: 100, amountCzk: 2300, date: '2024-01-10' });
    expect(l.trades[1]).toMatchObject({ quantity: -3, price: 25, amountCzk: 1500 });
    expect(l.cash.map((c) => c.kind).sort()).toEqual(['DEPOSIT', 'DIVIDEND', 'DIVIDEND_TAX', 'INTEREST']);
    expect(l.cash.every((c) => c.currency === 'CZK')).toBe(true);
  });
});

describe('xirr', () => {
  it('finds 10 % for a one-year doubling-ish flow', () => {
    expect(xirr([{ date: '2020-01-01', amount: -1000 }, { date: '2020-12-31', amount: 1100 }])).toBeCloseTo(0.1, 2);
  });
  it('returns null without sign change', () => {
    expect(xirr([{ date: '2020-01-01', amount: 100 }, { date: '2021-01-01', amount: 100 }])).toBeNull();
  });
});
