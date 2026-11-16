import { describe, expect, it } from 'vitest';
import {
  bankTxsFromTable,
  decodeBankText,
  detectBankKind,
  isBalancesFile,
  mergeBalances,
  readBalancesCsv,
  readBankTables,
  writeBalancesCsv,
  czDateToIso,
} from '../src/core/accounts/bankTables.js';
import { writeCsv } from '../src/core/exportTables.js';
import { detectFileKind } from '../src/core/parsers/index.js';
import { cp1250, fioCsv, kbCsv, rbCsv, type BankRow } from './bankFixtures.js';

const u8 = (d: string | Buffer) => new Uint8Array(typeof d === 'string' ? Buffer.from(d, 'utf-8') : d);

const FIO_ROWS: BankRow[] = [
  { id: '1001', date: '2025-01-03', amount: 5000, type: 'Bezhotovostní příjem', cp: '1234567', cpBank: '0100', cpName: 'TEST OWNER', vs: '77', message: 'Spoření' },
  {
    id: '1002',
    date: '2025-01-15',
    amount: -250.5,
    type: 'Platba kartou',
    ident: 'Nákup: ALBERT 1234, Praha, CZ, dne 14.1.2025, částka 250.50 CZK',
    detail: '10,00 EUR',
    note: 'moje poznámka',
  },
  { id: '1003', date: '2025-01-31', amount: 12.34, type: 'Připsaný úrok' },
];

const fio = (rows = FIO_ROWS) => fioCsv({ account: '2101234567', n: 1, from: '2025-01-01', to: '2025-01-31', open: 1000, close: 1000 + rows.reduce((s, r) => s + r.amount, 0), rows });

const KB_ROWS: BankRow[] = [
  { id: 'KB0000000001', date: '2025-02-03', valueDate: '2025-02-01', amount: 62000, type: 'Příchozí úhrada', cp: '2700112233/2010', cpName: 'ČEZ Prodej, a.s.', vs: '202501', message: 'Příliš žluťoučký kůň' },
  { id: 'KB0000000002', date: '2025-02-10', amount: -599, type: 'Odeslané inkaso', cp: '2000400404/0300', cpName: 'O2 Czech Republic', vs: '0012345', origAmount: -24, origCur: 'EUR' },
  { id: 'KB0000000003', date: '2025-02-28', amount: -99, type: 'Poplatek za tarif' },
];
const kb = (rows = KB_ROWS) => kbCsv({ account: '19-2000145398', from: '2025-02-01', to: '2025-02-28', open: 100, close: 100 + rows.reduce((s, r) => s + r.amount, 0), rows });

const RB_ROWS: BankRow[] = [
  { id: 'RB1', date: '2025-03-02', amount: -349, type: 'Platba kartou', category: 'Platba kartou', merchant: 'WOLT', city: 'PRAHA', message: 'PK: 5168 **** 1234' },
  { id: 'RB2', date: '2025-03-05', amount: 24000, type: 'Příchozí úhrada', category: 'Platba', cp: '19-2000145398/0100', cpName: 'NOVAK; JAN', message: 'Kapesné; březen', ident: 'pozn A', note: 'pozn B', valueDate: '2025-03-04' },
];
const rb = (extra?: Parameters<typeof rbCsv>[0]['other']) => rbCsv({ account: '1234567890', name: 'eKonto SMART', rows: RB_ROWS, other: extra });

describe('detection', () => {
  it('recognises each bank format by content, independent of the file name', () => {
    expect(detectBankKind('Vypis_z_uctu-2101234567_20250101-20250131_cislo-1.csv', u8(fio()))).toBe('BANK_FIO');
    expect(detectBankKind('whatever.csv', u8(fio()))).toBe('BANK_FIO');
    expect(detectBankKind('Vypis_19.csv', kb())).toBe('BANK_KB');
    expect(detectBankKind('Pohyby_1234567890_x.csv', u8(rb()))).toBe('BANK_RB');
    expect(detectBankKind('x.CSV', u8(rb()))).toBe('BANK_RB');
  });

  it('detects a Fio file with no transactions and a KB file without the intro line', () => {
    expect(detectBankKind('a.csv', u8(fio([])))).toBe('BANK_FIO');
    const noIntro = kb().toString('latin1').split('\r\n').slice(1).join('\r\n');
    expect(detectBankKind('a.csv', Buffer.from(noIntro, 'latin1'))).toBe('BANK_KB');
  });

  it('does not treat non-CSV names, Degiro exports or arbitrary CSVs as bank statements', () => {
    expect(detectBankKind('a.xlsx', u8(fio()))).toBeNull();
    expect(detectBankKind('a.txt', u8(fio()))).toBeNull();
    expect(detectBankKind('a.csv', u8('Datum;Castka;Protiucet\n1.1.2024;100;123\n'))).toBeNull();
    const txHeader = 'Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID\n';
    const accHeader = 'Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id\n';
    expect(detectBankKind('Transactions.csv', u8(txHeader))).toBeNull();
    expect(detectBankKind('Account.csv', u8(accHeader))).toBeNull();
  });

  it('detectFileKind returns the bank kinds and keeps Degiro/XTB detection unchanged', () => {
    expect(detectFileKind('a.csv', u8(fio()))).toBe('BANK_FIO');
    expect(detectFileKind('a.csv', kb())).toBe('BANK_KB');
    expect(detectFileKind('a.csv', u8(rb()))).toBe('BANK_RB');
    expect(detectFileKind('Transactions.csv', u8('Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID\n'))).toBe('DEGIRO_TX');
    expect(detectFileKind('Account.csv', u8('Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id\n'))).toBe('DEGIRO_ACCOUNT');
    expect(detectFileKind('CZK_1_2024.xlsx', u8('PK'))).toBe('XTB');
    expect(detectFileKind('x.zip', u8('PK'))).toBe('XTB');
    expect(detectFileKind('bank.csv', u8('Datum;Castka\n'))).toBe('UNKNOWN');
  });

  it('detects stored bank year files (marker row) and decodes cp1250 only when the bytes are not UTF-8', () => {
    const [t] = readBankTables('x.csv', u8(fio()));
    const stored = writeCsv(t.header, t.records);
    expect(stored.startsWith('#myfin-bank,1,FIO,2101234567,CZK')).toBe(true);
    expect(detectBankKind('transactions.csv', u8(stored))).toBe('BANK_FIO');
    expect(detectBankKind('transactions.csv', u8(stored.replace(',FIO,', ',KB,')))).toBe('BANK_KB');
    expect(decodeBankText(u8('﻿Ábc ž'))).toBe('Ábc ž');
    expect(decodeBankText(cp1250('Příliš žluťoučký'))).toBe('Příliš žluťoučký');
  });

  it('czDateToIso accepts D.M.YYYY and rejects impossible dates', () => {
    expect(czDateToIso('3.1.2025')).toBe('2025-01-03');
    expect(czDateToIso('03.01.2025 12:00:00')).toBe('2025-01-03');
    expect(czDateToIso('31.02.2025')).toBeNull();
    expect(czDateToIso('')).toBeNull();
    expect(czDateToIso(undefined)).toBeNull();
  });
});

describe('Fio parsing', () => {
  it('reads account, currency, declared period and balances (opening = day before the period)', () => {
    const tables = readBankTables('a.csv', u8(fio()));
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.kind).toBe('BANK_FIO');
    expect(t.unit).toBe('banks/fio/2101234567');
    expect(t.account).toBe('2101234567');
    expect(t.currency).toBe('CZK');
    expect(t.declaredRange).toEqual({ from: '2025-01-01', to: '2025-01-31' });
    expect(t.balances).toEqual([
      { date: '2024-12-31', balance: 1000 },
      { date: '2025-01-31', balance: 1000 + 5000 - 250.5 + 12.34 },
    ]);
    expect(t.records.map((r) => r.date)).toEqual(['2025-01-03', '2025-01-15', '2025-01-31']);
    expect(t.warnings).toEqual([]);
  });

  it('accepts thousands separators in the stated balances', () => {
    const text = fio().replace('stav účtu k 01.01.2025: 1000,00 CZK', 'stav účtu k 01.01.2025: 1 234,56 CZK');
    expect(readBankTables('a.csv', u8(text))[0].balances![0]).toEqual({ date: '2024-12-31', balance: 1234.56 });
  });

  it('maps columns, including the duplicated "Poznámka" column', () => {
    const { account, txs } = bankTxsFromTable(readBankTables('a.csv', u8(fio()))[0]);
    expect(account).toMatchObject({ id: '2101234567/2010', bank: 'FIO', number: '2101234567', currency: 'CZK' });
    expect(txs).toHaveLength(3);
    expect(txs[0]).toMatchObject({ amount: 5000, cpAccount: '1234567/0100', cpName: 'TEST OWNER', vs: '77', message: 'Spoření', bankType: 'Bezhotovostní příjem', bankTxId: '1001' });
    expect(txs[0].key).toBe('FIO:2101234567/2010:1001');
    expect(txs[1]).toMatchObject({
      amount: -250.5,
      merchant: 'ALBERT 1234',
      origAmount: 10,
      origCurrency: 'EUR',
      note: 'moje poznámka',
      message: 'Nákup: ALBERT 1234, Praha, CZ, dne 14.1.2025, částka 250.50 CZK',
    });
    expect(txs[2].cpAccount).toBeUndefined();
    expect(txs[2].vs).toBeUndefined();
  });

  it('an empty statement yields no records but keeps the account, period and balances', () => {
    const t = readBankTables('a.csv', u8(fio([])))[0];
    expect(t.records).toEqual([]);
    expect(t.declaredRange).toEqual({ from: '2025-01-01', to: '2025-01-31' });
    expect(t.balances).toHaveLength(2);
    expect(bankTxsFromTable(t).txs).toEqual([]);
  });

  it('skips rows without a valid date and warns', () => {
    const text = fio().replace('03.01.2025', '99.99.2025');
    const t = readBankTables('a.csv', u8(text))[0];
    expect(t.records).toHaveLength(2);
    expect(t.warnings.join(' ')).toContain('1 řádků');
  });

  it('rejects statements without account number or from another bank code', () => {
    expect(() => readBankTables('a.csv', u8(fio().replace(/z účtu ""2101234567\/2010""/, 'z účtu ""x""')), 'BANK_FIO')).toThrow();
    expect(() => readBankTables('a.csv', u8(fio().replace('/2010', '/0100')), 'BANK_FIO')).toThrow(/kódem banky/);
    expect(() => readBankTables('a.csv', u8('Neco;jineho\n1;2\n'))).toThrow(/neznámý formát/);
  });
});

describe('KB parsing', () => {
  it('reads cp1250 diacritics, account, period and balances', () => {
    const t = readBankTables('a.csv', kb())[0];
    expect(t.kind).toBe('BANK_KB');
    expect(t.unit).toBe('banks/kb/19-2000145398');
    expect(t.currency).toBe('CZK');
    expect(t.declaredRange).toEqual({ from: '2025-02-01', to: '2025-02-28' });
    expect(t.balances).toEqual([
      { date: '2025-01-31', balance: 100 },
      { date: '2025-02-28', balance: 100 + 62000 - 599 - 99 },
    ]);
    const { txs } = bankTxsFromTable(t);
    expect(txs).toHaveLength(3);
    const salary = txs.find((x) => x.bankTxId === 'KB0000000001')!;
    expect(salary.cpName).toBe('ČEZ Prodej, a.s.');
    expect(salary.message).toBe('Příliš žluťoučký kůň');
    expect(salary.bankType).toBe('Příchozí úhrada');
    expect(salary.valueDate).toBe('2025-02-01');
  });

  it('treats "0" payment symbols as empty and strips leading zeros', () => {
    const { txs } = bankTxsFromTable(readBankTables('a.csv', kb())[0]);
    const fee = txs.find((x) => x.bankTxId === 'KB0000000003')!;
    expect(fee.vs).toBeUndefined();
    expect(fee.ks).toBeUndefined();
    expect(fee.ss).toBeUndefined();
    expect(txs.find((x) => x.bankTxId === 'KB0000000001')!.ks).toBeUndefined();
    const inkaso = txs.find((x) => x.bankTxId === 'KB0000000002')!;
    expect(inkaso.vs).toBe('12345');
    expect(inkaso).toMatchObject({ origAmount: -24, origCurrency: 'EUR', amount: -599, currency: 'CZK' });
    expect(inkaso.valueDate).toBeUndefined(); // same as booking date
  });

  it('requires the account number', () => {
    const text = kb().toString('latin1').replace('Cislo uctu;19-2000145398', 'Cislo uctu;');
    expect(() => readBankTables('a.csv', Buffer.from(text, 'latin1'), 'BANK_KB')).toThrow(/číslo účtu/);
  });

  it('takes the balance from the column of the account currency', () => {
    const rows: BankRow[] = [{ id: 'E1', date: '2025-02-05', amount: 10, type: 'Příchozí úhrada', cur: 'EUR' }];
    const text = kbCsv({ account: '5-1234567', from: '2025-02-01', to: '2025-02-28', open: 0, close: 10, cur: 'EUR', rows }).toString('latin1');
    // the balance rows list CZK first, then EUR: put distinct numbers into the EUR column
    const patched = text.replace('Pocatecni zustatek;0,00', 'Pocatecni zustatek;1,00;2,00').replace('Konecny zustatek;10,00', 'Konecny zustatek;1,00;12,00');
    const t = readBankTables('a.csv', Buffer.from(patched, 'latin1'))[0];
    expect(t.currency).toBe('EUR');
    expect(t.balances).toEqual([
      { date: '2025-01-31', balance: 2 },
      { date: '2025-02-28', balance: 12 },
    ]);
  });
});

describe('Raiffeisenbank parsing', () => {
  it('reads quoted fields containing ";", names, merchants and categories; no period and no balances', () => {
    const tables = readBankTables('a.csv', u8(rb()));
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.kind).toBe('BANK_RB');
    expect(t.unit).toBe('banks/rb/1234567890');
    expect(t.declaredRange).toBeUndefined();
    expect(t.balances).toBeUndefined();
    const { account, txs } = bankTxsFromTable(t);
    expect(account).toMatchObject({ id: '1234567890/5500', name: 'eKonto SMART', currency: 'CZK' });
    const card = txs.find((x) => x.bankTxId === 'RB1')!;
    expect(card).toMatchObject({ merchant: 'WOLT', city: 'PRAHA', bankCategory: 'Platba kartou', amount: -349 });
    const inc = txs.find((x) => x.bankTxId === 'RB2')!;
    expect(inc.cpName).toBe('NOVAK; JAN');
    expect(inc.message).toBe('Kapesné; březen');
    expect(inc.note).toBe('pozn A · pozn B');
    expect(inc.cpAccount).toBe('19-2000145398/0100');
    expect(inc.valueDate).toBe('2025-03-04'); // execution date differs from booking date 2025-03-05
    expect(inc.date).toBe('2025-03-05');
  });

  it('a file with two accounts becomes two tables', () => {
    const other: BankRow[] = [{ id: 'RS1', date: '2025-03-31', amount: 1000, type: 'Inteligentní spoření - převod prostředků na spořicí účet' }];
    const tables = readBankTables('a.csv', u8(rb({ account: '1234567891', name: 'Spořicí účet', rows: other })));
    expect(tables.map((t) => t.unit)).toEqual(['banks/rb/1234567890', 'banks/rb/1234567891']);
    expect(tables[0].records).toHaveLength(2);
    expect(tables[1].records).toHaveLength(1);
    expect(bankTxsFromTable(tables[1]).account.name).toBe('Spořicí účet');
  });

  it('requires the account column', () => {
    expect(() => readBankTables('a.csv', u8('"Datum provedení";"Zaúčtovaná částka";"Id transakce"\n"1.1.2025";"1";"x"\n'), 'BANK_RB')).toThrow(/Číslo účtu/);
  });
});

describe('transaction keys', () => {
  it('are stable across re-reads and made unique for identical rows without an id', () => {
    const dup: BankRow = { id: '', date: '2025-03-10', amount: -10, type: 'Platba kartou', merchant: 'KAVA' };
    const text = rbCsv({ account: '1234567890', name: 'x', rows: [dup, dup, { ...dup, id: 'RB9' }] });
    const a = bankTxsFromTable(readBankTables('a.csv', u8(text))[0]).txs.map((t) => t.key);
    const b = bankTxsFromTable(readBankTables('a.csv', u8(text))[0]).txs.map((t) => t.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
    expect(a[0]).toMatch(/^RB:1234567890\/5500:h[0-9a-f]{8}$/);
    expect(a[1]).toBe(`${a[0]}#1`);
    expect(a[2]).toBe('RB:1234567890/5500:RB9');
  });
});

describe('stored file round trip', () => {
  const cases: [string, Uint8Array][] = [
    ['FIO', u8(fio())],
    ['KB', new Uint8Array(kb())],
    ['RB', u8(rb())],
  ];
  for (const [name, data] of cases) {
    it(`${name}: writeCsv -> readBankTables gives identical records and transactions`, () => {
      const [t] = readBankTables('export.csv', data);
      const stored = writeCsv(t.header, t.records);
      const [back] = readBankTables('transactions.csv', u8(stored), t.kind as 'BANK_FIO');
      expect(back.kind).toBe(t.kind);
      expect(back.unit).toBe(t.unit);
      expect(back.currency).toBe(t.currency);
      expect(back.header).toEqual(t.header);
      expect(back.records.map((r) => r.key)).toEqual(t.records.map((r) => r.key));
      expect(back.records.map((r) => r.date)).toEqual(t.records.map((r) => r.date));
      expect(bankTxsFromTable(back).txs).toEqual(bankTxsFromTable(t).txs);
    });
  }

  it('stored files of another bank kind or without a marker are rejected', () => {
    const [t] = readBankTables('export.csv', u8(fio()));
    const stored = writeCsv(t.header, t.records);
    expect(() => readBankTables('transactions.csv', u8(stored), 'BANK_KB')).toThrow(/uložený soubor/);
  });
});

describe('balances file', () => {
  const meta = { bank: 'KB' as const, number: '19-2000145398', currency: 'CZK' };

  it('round trips and sorts by date', () => {
    const text = writeBalancesCsv(meta, [
      { date: '2025-02-28', balance: 61402 },
      { date: '2025-01-31', balance: 100.5 },
    ]);
    expect(text.split('\n')[0]).toBe('#myfin-bank,1,KB,19-2000145398,CZK');
    expect(detectBankKind('balances.csv', u8(text))).toBe('BANK_KB');
    const back = readBalancesCsv(text);
    expect(back.meta).toEqual(meta);
    expect(back.points).toEqual([
      { date: '2025-01-31', balance: 100.5 },
      { date: '2025-02-28', balance: 61402 },
    ]);
  });

  it('sanitises the account number and ignores malformed rows', () => {
    const text = writeBalancesCsv({ ...meta, number: '1,2"3\n4' }, []);
    expect(readBalancesCsv(text).meta!.number).toBe('1234');
    const dirty = `${text}not-a-date,5\n2025-01-01,abc\n2025-01-02,7\n`;
    expect(readBalancesCsv(dirty).points).toEqual([{ date: '2025-01-02', balance: 7 }]);
  });

  it('mergeBalances is a union by date; the incoming value wins', () => {
    expect(
      mergeBalances(
        [
          { date: '2025-01-31', balance: 1 },
          { date: '2025-03-31', balance: 3 },
        ],
        [
          { date: '2025-02-28', balance: 2 },
          { date: '2025-03-31', balance: 33 },
        ],
      ),
    ).toEqual([
      { date: '2025-01-31', balance: 1 },
      { date: '2025-02-28', balance: 2 },
      { date: '2025-03-31', balance: 33 },
    ]);
    expect(mergeBalances([], [])).toEqual([]);
  });

  it('isBalancesFile matches the stored file name with both separators', () => {
    expect(isBalancesFile('banks/fio/2101234567/balances.csv')).toBe(true);
    expect(isBalancesFile('banks\\fio\\2101234567\\balances.csv')).toBe(true);
    expect(isBalancesFile('balances.csv')).toBe(true);
    expect(isBalancesFile('banks/fio/2101234567/2025/transactions.csv')).toBe(false);
    expect(isBalancesFile('my-balances.csv')).toBe(false);
  });
});
