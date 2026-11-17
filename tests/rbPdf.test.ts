import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  bankAccountFolder,
  bankAccountId,
  bankTxsFromTable,
  detectBankKind,
  isStatementsFile,
  readBankTables,
  readStatementsCsv,
  writeStatementsCsv,
} from '../src/core/accounts/bankTables.js';
import { writeCsv } from '../src/core/exportTables.js';
import { pdfPages } from '../src/core/accounts/pdfText.js';
import { NotRbStatementError, parseRbStatement } from '../src/core/accounts/rbPdf.js';
import { looksLikePdfStatements, readRbPdfTables, RB_PDF_COLUMNS } from '../src/core/accounts/rbPdfTables.js';
import { detectFileKind } from '../src/core/parsers/index.js';
import { rbStatementPdf, type SyntheticStatement, type SyntheticTx } from './helpers/rbStatementPdf.js';

/** RB prints the "Valuta" row for every movement; the generator prints it when valueDate is set. */
const withValuta = (st: SyntheticStatement): SyntheticStatement => ({ ...st, txs: st.txs.map((t) => ({ ...t, valueDate: t.valueDate ?? t.date })) });
const parse = async (st: SyntheticStatement) => parseRbStatement(await pdfPages(rbStatementPdf(withValuta(st))));

const TXS: SyntheticTx[] = [
  { date: '2025-03-03', code: '1000001', category: 'Platba', type: 'Příchozí úhrada', amount: 24000, cpAccount: '19-1234567890/0100', cpName: 'NOVAK JAN', message: 'Kapesne', vs: '77', ks: '0308', ss: '5' },
  { date: '2025-03-05', valueDate: '2025-03-04', code: '1000002', category: 'Platba kartou', type: 'Platba kartou', amount: -349.5, cpName: 'JAN TESTOVACI', card: { merchant: 'WOLT', city: 'PRAHA', country: 'CZE' } },
  { date: '2025-03-10', code: '1000003', category: 'Nákupy', type: 'Platba kartou v cizí měně', amount: -2300.4, fee: -12.5, origAmount: -100, origCurrency: 'EUR', rate: 23.004, card: { merchant: 'SHOP ABC', city: 'BERLIN', country: 'DEU' } },
  { date: '2025-03-20', code: '1000004', category: 'Služby', type: 'Trvalý příkaz', amount: -1500, cpAccount: '123456789/0800', cpName: 'ENERGIE A.S.', message: 'Zaloha', note: 'Poznamka' },
];
const MARCH: SyntheticStatement = { number: '1234567890', seq: 3, from: '2025-03-01', to: '2025-03-31', opening: 1000, txs: TXS };

describe('parseRbStatement', () => {
  it('reads the header, balances and totals (current template)', async () => {
    const s = await parse(MARCH);
    expect(s).toMatchObject({ number: '1234567890', currency: 'CZK', seq: 3, from: '2025-03-01', to: '2025-03-31', opening: 1000, txCount: 4 });
    expect(s.closing).toBeCloseTo(1000 + 24000 - 349.5 - 2300.4 - 12.5 - 1500, 2);
    expect(s.income).toBe(24000);
    expect(s.fees).toBe(12.5);
    expect(s.expense).toBeCloseTo(349.5 + 2300.4 + 1500 + 12.5, 2);
    expect(s.warnings).toEqual([]);
  });

  it('reads the three-row movements', async () => {
    const s = await parse(MARCH);
    expect(s.txs).toHaveLength(4);
    expect(s.txs[0]).toMatchObject({
      date: '2025-03-03',
      code: '1000001',
      category: 'Platba',
      type: 'Příchozí úhrada',
      amount: 24000,
      currency: 'CZK',
      cpAccount: '19-1234567890/0100',
      cpName: 'NOVAK JAN',
      message: 'Kapesne',
      vs: '77',
      ks: '0308'.replace(/^0+/, ''),
      ss: '5',
    });
    expect(s.txs[0].valueDate).toBeUndefined();
    expect(s.txs[3]).toMatchObject({ type: 'Trvalý příkaz', amount: -1500, message: 'Zaloha', note: 'Poznamka', cpName: 'ENERGIE A.S.' });
    // value date kept only when it differs from the booking date
    expect(s.txs[1].valueDate).toBe('2025-03-04');
  });

  it('drops the card number and the card holder name, splits merchant; city; country', async () => {
    const s = await parse(MARCH);
    const card = s.txs[1];
    expect(card).toMatchObject({ merchant: 'WOLT', city: 'PRAHA', country: 'CZE' });
    expect(card.cpName).toBeUndefined();
    expect(card.note).toBeUndefined();
    const json = JSON.stringify(s);
    expect(json).not.toContain('123456XXXXXX7890');
    expect(json).not.toContain('PK:');
    expect(json).not.toContain('JAN TESTOVACI');
  });

  it('reads the fee, original amount and rate', async () => {
    const t = (await parse(MARCH)).txs[2];
    expect(t).toMatchObject({ amount: -2300.4, fee: -12.5, origAmount: -100, origCurrency: 'EUR', rate: 23.004, merchant: 'SHOP ABC', city: 'BERLIN', country: 'DEU' });
  });

  it('reads a wrapped transaction type without mixing it up with the message', async () => {
    const s = await parse({ ...MARCH, txs: [{ date: '2025-03-03', code: '2000001', category: 'Platba', type: 'Odchozí úhrada', wrapType: 'do jiné banky', amount: -100, message: 'Zprava' }, TXS[0]], opening: 500 });
    expect(s.warnings).toEqual([]);
    expect(s.txs).toHaveLength(2);
    expect(s.txs[0].type).toBe('Odchozí úhrada do jiné banky');
    expect(s.txs[0].message).toBe('Zprava');
    expect(s.txs[0].code).toBe('2000001');
    expect(s.txs[1].code).toBe('1000001');
  });

  it('reads the older template with spaced dates', async () => {
    const s = await parse({ ...MARCH, oldTemplate: true });
    expect(s).toMatchObject({ number: '1234567890', seq: 3, from: '2025-03-01', to: '2025-03-31', opening: 1000, txCount: 4 });
    expect(s.warnings).toEqual([]);
    expect(s.txs.map((t) => t.code)).toEqual(['1000001', '1000002', '1000003', '1000004']);
    expect(s.txs[1]).toMatchObject({ merchant: 'WOLT', valueDate: '2025-03-04' });
    expect(s.txs[1].cpName).toBeUndefined();
    expect(s.txs[2]).toMatchObject({ fee: -12.5, origAmount: -100, origCurrency: 'EUR' });
  });

  it('reads a multi-page statement', async () => {
    const txs: SyntheticTx[] = Array.from({ length: 20 }, (_, i) => ({
      date: `2025-03-${String(i + 1).padStart(2, '0')}`,
      code: String(3000000 + i),
      category: 'Platba',
      type: 'Odchozí úhrada',
      amount: -(i + 1) * 10,
      cpName: `PARTNER ${i}`,
    }));
    const pdf = rbStatementPdf(withValuta({ ...MARCH, opening: 10000, txs, perPage: 6 }));
    const pages = await pdfPages(pdf);
    expect(pages).toHaveLength(4);
    const s = parseRbStatement(pages);
    expect(s.warnings).toEqual([]);
    expect(s.txs).toHaveLength(20);
    expect(s.txs.map((t) => t.cpName)).toEqual(txs.map((t) => t.cpName));
    expect(s.txs[19].amount).toBe(-200);
  });

  it('reads a statement without movements ("Žádné transakce")', async () => {
    const s = await parse({ ...MARCH, opening: 777, txs: [] });
    expect(s.txs).toEqual([]);
    expect(s).toMatchObject({ opening: 777, closing: 777, txCount: 0, income: 0, expense: 0 });
    expect(s.warnings).toEqual([]);
  });

  it('reads a foreign currency statement', async () => {
    const s = await parse({ ...MARCH, currency: 'USD', opening: 100, txs: [{ date: '2025-03-03', code: '4000001', category: 'Platba', type: 'Příchozí úhrada', amount: 50.25, cpName: 'ACME' }] });
    expect(s.currency).toBe('USD');
    expect(s.txs[0].currency).toBe('USD');
    expect(s.closing).toBe(150.25);
  });

  it('warns when the movements do not add up to the stated balances', async () => {
    const s = await parse({ ...MARCH, closing: 99999 });
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/nesedí na jeho zůstatky/);
    expect(s.txs).toHaveLength(4);
  });

  it('throws NotRbStatementError for other PDFs and for a foreign bank code', async () => {
    const fees = await pdfPages(rbStatementPdf(withValuta({ ...MARCH, title: 'Poplatky a úroky' })));
    // a "Výpis poplatků" has no "Výpis z" title
    expect(() => parseRbStatement(fees)).toThrow(NotRbStatementError);
    expect(() => parseRbStatement([[{ x: 10, y: 10, w: 50, s: 'Hello world' }]])).toThrow(NotRbStatementError);
    expect(() => parseRbStatement([])).toThrow(NotRbStatementError);
    const other = await pdfPages(rbStatementPdf(withValuta({ ...MARCH, bankCode: '0100' })));
    expect(() => parseRbStatement(other)).toThrow(/kódem banky/);
  });
});

// ---------- readRbPdfTables ----------

const stmt = (over: Partial<SyntheticStatement> & Pick<SyntheticStatement, 'seq' | 'from' | 'to' | 'opening'>): SyntheticStatement => ({
  number: '1234567890',
  txs: [],
  ...over,
});
const tx = (date: string, code: string, amount: number, extra: Partial<SyntheticTx> = {}): SyntheticTx => ({ date, code, category: 'Platba', type: 'Odchozí úhrada', amount, cpName: 'PARTNER', ...extra });

const JAN = stmt({ seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 1000, txs: [tx('2025-01-05', '5000001', 500, { type: 'Příchozí úhrada' }), tx('2025-01-20', '5000002', -200)] });
const FEB = stmt({ seq: 2, from: '2025-02-01', to: '2025-02-28', opening: 1300, txs: [tx('2025-02-05', '5000003', 500, { type: 'Příchozí úhrada' })] });

async function zipOf(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [n, d] of Object.entries(files)) z.file(n, d);
  return z.generateAsync({ type: 'uint8array' });
}
const pdf = (st: SyntheticStatement) => rbStatementPdf(withValuta(st));

describe('readRbPdfTables', () => {
  it('turns a single PDF into one table with periods, balances, statements and an attachment', async () => {
    const [t, ...rest] = await readRbPdfTables('vypis.pdf', pdf(JAN));
    expect(rest).toEqual([]);
    expect(t.kind).toBe('BANK_RB_PDF');
    expect(t.unit).toBe('banks/rb/1234567890/pdf');
    expect(t.account).toBe('1234567890');
    expect(t.currency).toBe('CZK');
    expect(t.label).toContain('PDF výpisy');
    expect(t.header[0]).toEqual(['#myfin-bank', '1', 'RB', '1234567890', 'CZK', 'pdf']);
    expect(t.header[1]).toEqual(RB_PDF_COLUMNS);
    expect(t.records).toHaveLength(2);
    expect(t.periods).toEqual([{ from: '2025-01-01', to: '2025-01-31' }]);
    expect(t.declaredRange).toEqual({ from: '2025-01-01', to: '2025-01-31' });
    expect(t.balances).toEqual([
      { date: '2024-12-31', balance: 1000 },
      { date: '2025-01-31', balance: 1300 },
    ]);
    expect(t.statements).toEqual([{ seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 1000, closing: 1300, income: 500, expense: 200, fees: 0, txCount: 2 }]);
    expect(t.attachments).toHaveLength(1);
    expect(t.attachments![0].path).toBe('2025/statements/vypis_2025-01-01_2025-01-31_1.pdf');
    expect(Buffer.from(t.attachments![0].data).subarray(0, 4).toString()).toBe('%PDF');
    expect(t.warnings).toEqual([]);
  });

  it('reads a zip with several statements of one account in date order', async () => {
    const [t, ...rest] = await readRbPdfTables('vypisy.zip', await zipOf({ 'b_feb.pdf': pdf(FEB), 'a_jan.pdf': pdf(JAN) }));
    expect(rest).toEqual([]);
    expect(t.records).toHaveLength(3);
    expect(t.periods).toEqual([
      { from: '2025-01-01', to: '2025-01-31' },
      { from: '2025-02-01', to: '2025-02-28' },
    ]);
    expect(t.declaredRange).toEqual({ from: '2025-01-01', to: '2025-02-28' });
    expect(t.statements!.map((s) => s.seq)).toEqual([1, 2]);
    expect(t.attachments!.map((a) => a.path)).toEqual(['2025/statements/vypis_2025-01-01_2025-01-31_1.pdf', '2025/statements/vypis_2025-02-01_2025-02-28_2.pdf']);
    expect(t.balances!.map((b) => `${b.date}:${b.balance}`)).toEqual(['2024-12-31:1000', '2025-01-31:1300', '2025-01-31:1300', '2025-02-28:1800']);
  });

  it('splits accounts, including a USD sub-account with the number of the CZK account', async () => {
    const usd = stmt({ seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 10, currency: 'USD', txs: [tx('2025-01-07', '6000001', 5, { type: 'Příchozí úhrada' })] });
    const other = stmt({ number: '1234567891', seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 0, txs: [] });
    const tables = await readRbPdfTables('v.zip', await zipOf({ 'czk.pdf': pdf(JAN), 'usd.pdf': pdf(usd), 'other.pdf': pdf(other) }));
    expect(tables.map((t) => t.unit).sort()).toEqual(['banks/rb/1234567890/pdf', 'banks/rb/1234567890_USD/pdf', 'banks/rb/1234567891/pdf']);
    const u = tables.find((t) => t.currency === 'USD')!;
    expect(u.account).toBe('1234567890_USD');
    expect(u.records).toHaveLength(1);
    expect(u.header[0]).toEqual(['#myfin-bank', '1', 'RB', '1234567890', 'USD', 'pdf']);
    const { account, txs } = bankTxsFromTable(u);
    expect(account.id).toBe('1234567890/5500/USD');
    expect(txs[0].key).toBe('RB:1234567890/5500/USD:6000001');
    expect(txs[0].source).toBe('pdf');
  });

  it('skips a non-statement PDF in the zip with a warning', async () => {
    const fees = pdf({ ...JAN, title: 'Poplatky' });
    // the fee statement has no "Výpis z" title: build it from the generic text
    const notStatement = new Uint8Array(Buffer.from(Buffer.from(fees).toString('latin1').replace('Výpis z běžného účtu'.replace('ý', '\xfd').replace('í', '\xed'), 'Faktura').replace('Poplatky', 'Faktura'), 'latin1'));
    const tables = await readRbPdfTables('v.zip', await zipOf({ 'jan.pdf': pdf(JAN), 'faktura.pdf': notStatement }));
    expect(tables).toHaveLength(1);
    expect(tables[0].records).toHaveLength(2);
    expect(tables[0].warnings.some((w) => w.includes('Přeskočeno 1 PDF') && w.includes('faktura.pdf'))).toBe(true);
  });

  it('counts the same statement twice in a zip once', async () => {
    const [t] = await readRbPdfTables('v.zip', await zipOf({ 'a.pdf': pdf(JAN), 'copy/b.pdf': pdf(JAN) }));
    expect(t.records).toHaveLength(2);
    expect(t.statements).toHaveLength(1);
    expect(t.attachments).toHaveLength(1);
    expect(t.periods).toHaveLength(1);
  });

  it('keeps a transaction code that appears in overlapping statements once', async () => {
    const a = stmt({ seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 0, txs: [tx('2025-01-31', '7000001', 10, { type: 'Příchozí úhrada' })] });
    const b = stmt({ seq: 2, from: '2025-01-31', to: '2025-02-10', opening: 10, txs: [tx('2025-01-31', '7000001', 10, { type: 'Příchozí úhrada' })], closing: 10 });
    const [t] = await readRbPdfTables('v.zip', await zipOf({ 'a.pdf': pdf(a), 'b.pdf': pdf(b) }));
    expect(t.records).toHaveLength(1);
    expect(t.statements).toHaveLength(2);
  });

  it('a PDF that is not an RB statement throws NotRbStatementError; so does a zip without statements', async () => {
    const other = pdf({ ...JAN, bankCode: '0100' });
    await expect(readRbPdfTables('x.pdf', other)).rejects.toThrow(NotRbStatementError);
    await expect(readRbPdfTables('x.zip', await zipOf({ 'x.pdf': other }))).rejects.toThrow(NotRbStatementError);
    await expect(readRbPdfTables('x.zip', await zipOf({ 'readme.txt': new Uint8Array([65]) }))).rejects.toThrow(NotRbStatementError);
    await expect(readRbPdfTables('x.zip', new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(NotRbStatementError);
  });

  it('rejects a zip whose PDF entry inflates beyond the limit (zip bomb) as not-a-statement', async () => {
    const z = new JSZip();
    z.file('bomb.pdf', Buffer.alloc(210 * 1024 * 1024), { compression: 'DEFLATE', compressionOptions: { level: 9 } });
    const data = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    expect(data.length).toBeLessThan(10 * 1024 * 1024);
    await expect(readRbPdfTables('bomb.zip', data)).rejects.toThrow(NotRbStatementError);
    await expect(readRbPdfTables('bomb.zip', data)).rejects.toThrow(/příliš velký/);
  }, 120_000);

  it('an unreadable single PDF is NotRbStatementError', async () => {
    await expect(readRbPdfTables('x.pdf', new Uint8Array(Buffer.from('%PDF-1.4 garbage')))).rejects.toThrow(NotRbStatementError);
  });

  it('writes a statement without movements as an (empty) table that still has a period and balances', async () => {
    const [t] = await readRbPdfTables('e.pdf', pdf(stmt({ seq: 4, from: '2025-04-01', to: '2025-04-30', opening: 50 })));
    expect(t.records).toEqual([]);
    expect(t.periods).toEqual([{ from: '2025-04-01', to: '2025-04-30' }]);
    expect(t.balances).toEqual([
      { date: '2025-03-31', balance: 50 },
      { date: '2025-04-30', balance: 50 },
    ]);
  });

  it('stores movements in RB CSV columns: fee as a separate movement, no card number, no holder name', async () => {
    const [t] = await readRbPdfTables('m.pdf', pdf(MARCH));
    const stored = JSON.stringify(t.records) + JSON.stringify(t.header);
    expect(stored).not.toContain('123456XXXXXX7890');
    expect(stored).not.toContain('JAN TESTOVACI');
    const { txs } = bankTxsFromTable(t);
    const fee = txs.find((x) => x.key.endsWith('#fee'))!;
    expect(fee).toMatchObject({ amount: -12.5, bankType: 'Poplatek', bankTxId: '1000003', source: 'pdf', date: '2025-03-10' });
    const main = txs.find((x) => x.bankTxId === '1000003' && !x.key.endsWith('#fee'))!;
    expect(main).toMatchObject({ amount: -2300.4, origAmount: -100, origCurrency: 'EUR', merchant: 'SHOP ABC', city: 'BERLIN' });
    // all movements together reproduce the closing balance
    const total = txs.reduce((s, x) => s + x.amount, 0);
    expect(1000 + total).toBeCloseTo(t.balances![1].balance, 2);
  });
});

// ---------- detection ----------

describe('PDF detection', () => {
  it('looksLikePdfStatements: %PDF bytes, .pdf name, zip whose first entry is a PDF', async () => {
    expect(looksLikePdfStatements('x.bin', pdf(JAN))).toBe(true);
    expect(looksLikePdfStatements('X.PDF', new Uint8Array([1, 2, 3]))).toBe(true);
    expect(looksLikePdfStatements('v.zip', await zipOf({ 'a.pdf': pdf(JAN) }))).toBe(true);
    expect(looksLikePdfStatements('v.zip', await zipOf({ 'A.PDF': pdf(JAN) }))).toBe(true);
    expect(looksLikePdfStatements('x.zip', await zipOf({ 'book.xlsx': new Uint8Array([1, 2, 3]) }))).toBe(false);
    expect(looksLikePdfStatements('a.csv', new Uint8Array(Buffer.from('a,b,c\n1,2,3\n')))).toBe(false);
    expect(looksLikePdfStatements('a.zip', new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(false);
  });

  it('detectFileKind: PDF and pdf-zip are BANK_RB_PDF, an XTB zip is still XTB', async () => {
    expect(detectFileKind('vypis.pdf', pdf(JAN))).toBe('BANK_RB_PDF');
    expect(detectFileKind('vypisy.zip', await zipOf({ 'a.pdf': pdf(JAN) }))).toBe('BANK_RB_PDF');
    expect(detectFileKind('export.zip', await zipOf({ 'CZK_123_2025.xlsx': new Uint8Array([1, 2, 3]) }))).toBe('XTB');
    expect(detectFileKind('book.xlsx', new Uint8Array([1, 2, 3]))).toBe('XTB');
  });

  it('a stored PDF year file is detected as BANK_RB_PDF and read back with the same rows', async () => {
    const [t] = await readRbPdfTables('m.pdf', pdf(MARCH));
    const text = writeCsv(t.header, t.records);
    expect(detectBankKind('banks/rb/1234567890/2025/statement-transactions.csv', new Uint8Array(Buffer.from(text)))).toBe('BANK_RB_PDF');
    const [back] = readBankTables('statement-transactions.csv', new Uint8Array(Buffer.from(text)));
    expect(back.kind).toBe('BANK_RB_PDF');
    expect(back.unit).toBe('banks/rb/1234567890/pdf');
    expect(back.records).toHaveLength(t.records.length);
  });
});

// ---------- ids, folders, statements.csv ----------

describe('bankAccountId / bankAccountFolder', () => {
  it('RB non-CZK sub-accounts get the currency in id and folder; everything else is unchanged', () => {
    expect(bankAccountId('RB', '1234567890', 'CZK')).toBe('1234567890/5500');
    expect(bankAccountId('RB', '1234567890', 'USD')).toBe('1234567890/5500/USD');
    expect(bankAccountId('FIO', '2101234567', 'EUR')).toBe('2101234567/2010');
    expect(bankAccountId('KB', '19-1234567890', 'USD')).toBe('19-1234567890/0100');
    expect(bankAccountFolder('RB', '1234567890', 'CZK')).toBe('1234567890');
    expect(bankAccountFolder('RB', '1234567890', 'USD')).toBe('1234567890_USD');
    expect(bankAccountFolder('FIO', '2101234567', 'EUR')).toBe('2101234567');
  });
});

describe('statements.csv', () => {
  const list = [
    { seq: 2, from: '2025-02-01', to: '2025-02-28', opening: 1300, closing: 1800, income: 500, expense: 0, fees: 0, txCount: 1 },
    { seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 1000, closing: 1287.5, income: 500, expense: 212.5, fees: 12.5, txCount: 3 },
  ];
  it('round-trips and sorts by period; the marker is not a bank year file', () => {
    const text = writeStatementsCsv({ bank: 'RB', number: '1234567890', currency: 'USD' }, list);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('#myfin-bank,1,RB,1234567890,USD,statements');
    expect(lines[2].startsWith('1,2025-01-01')).toBe(true);
    const back = readStatementsCsv(text);
    expect(back.meta).toEqual({ bank: 'RB', number: '1234567890', currency: 'USD' });
    expect(back.statements).toEqual([list[1], list[0]]);
    expect(detectBankKind('statements.csv', new Uint8Array(Buffer.from(text)))).toBeNull();
  });
  it('recognises the file name and ignores foreign or damaged content', () => {
    expect(isStatementsFile('banks/rb/123/statements.csv')).toBe(true);
    expect(isStatementsFile('banks\\rb\\123\\statements.CSV')).toBe(true);
    expect(isStatementsFile('banks/rb/123/2025/transactions.csv')).toBe(false);
    expect(readStatementsCsv('a,b\n1,2\n')).toEqual({ meta: null, statements: [] });
    const bad = '#myfin-bank,1,RB,1,CZK,statements\nseq,from,to\n1,2025-01-01,xx,1,2,3,4,5,6\n1,2025-01-01,2025-01-31,1,2,3\nx,2025-01-01,2025-01-31,1,2,3,4,5,6\n';
    expect(readStatementsCsv(bad).statements).toHaveLength(1);
  });
});
