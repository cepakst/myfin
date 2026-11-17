import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bankTxsFromTable, readBankTables } from '../src/core/accounts/bankTables.js';
import { buildBankLedger } from '../src/core/accounts/ledger.js';
import { commitImport, loadExportsForSnapshot, MANIFEST_FILE, previewUpload } from '../src/server/importer.js';
import { classifyExportFiles, relExportPath } from '../src/server/store.js';
import { RB_HEADER } from './bankFixtures.js';
import { rbStatementPdf, type SyntheticStatement, type SyntheticTx } from './helpers/rbStatementPdf.js';

// ---------- synthetic data ----------

const ACC = '1234567890';
const ID = `${ACC}/5500`;
const UNIT = `banks/rb/${ACC}`;

const tx = (date: string, code: string, amount: number, extra: Partial<SyntheticTx> = {}): SyntheticTx => ({
  date,
  valueDate: date,
  code,
  category: 'Platba',
  type: amount > 0 ? 'Příchozí úhrada' : 'Odchozí úhrada',
  amount,
  cpName: 'PARTNER',
  ...extra,
});
const stmt = (over: Partial<SyntheticStatement> & Pick<SyntheticStatement, 'seq' | 'from' | 'to' | 'opening'>): SyntheticStatement => ({ number: ACC, txs: [], ...over });

const J1 = tx('2025-01-05', '9000001', 500, { cpName: 'ZAMESTNAVATEL' });
const J2 = tx('2025-01-20', '9000002', -200, { category: 'Nákupy', type: 'Platba kartou', fee: -5, cpName: 'JAN TESTOVACI', card: { merchant: 'KAVARNA', city: 'BRNO', country: 'CZE' } });
const M1 = tx('2025-03-05', '9000003', 300);
const JAN = stmt({ seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 1000, txs: [J1, J2] }); // closes at 1295
const MAR = stmt({ seq: 3, from: '2025-03-01', to: '2025-03-31', opening: 1295, txs: [M1] }); // 1595
const FEB = stmt({ seq: 2, from: '2025-02-01', to: '2025-02-28', opening: 1295, txs: [] });

const pdf = (s: SyntheticStatement) => Buffer.from(rbStatementPdf(s));
async function zipOf(files: Record<string, Buffer>): Promise<Buffer> {
  const z = new JSZip();
  for (const [n, d] of Object.entries(files)) z.file(n, d);
  return z.generateAsync({ type: 'nodebuffer' });
}

interface CsvRow {
  id: string;
  date: string;
  amount: number;
  fee?: number;
  type?: string;
  cpName?: string;
  merchant?: string;
  city?: string;
  message?: string;
  valueDate?: string;
}
const q = (v: string | number | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const cz = (n: number) => n.toFixed(2).replace('.', ',');
/** RB CSV export (the fee goes to the "Poplatky" column) */
function rbCsvText(rows: CsvRow[], account = ACC): Buffer {
  const cells = (r: CsvRow): Record<string, string> => ({
    'Datum provedení': dmy(r.valueDate ?? r.date),
    'Datum zaúčtování': dmy(r.date),
    'Číslo účtu': `${account}/5500`,
    'Název účtu': 'eKonto TEST',
    'Typ transakce': r.type ?? (r.amount > 0 ? 'Příchozí úhrada' : 'Odchozí úhrada'),
    'Název protiúčtu': r.cpName ?? '',
    Zpráva: r.message ?? '',
    'Zaúčtovaná částka': cz(r.amount),
    'Měna účtu': 'CZK',
    Poplatky: r.fee === undefined ? '' : cz(r.fee),
    'Id transakce': r.id,
    'Název obchodníka': r.merchant ?? '',
    Město: r.city ?? '',
  });
  const lines = rows.map((r) => RB_HEADER.map((h) => q(cells(r)[h])).join(';'));
  return Buffer.from('﻿' + [RB_HEADER.map(q).join(';'), ...lines].join('\r\n') + '\r\n', 'utf-8');
}

// ---------- helpers ----------

let store: string;
let inbox: string;
const cleanup: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'myfin-rbpdf-test-'));
  cleanup.push(d);
  return d;
};
beforeEach(() => {
  store = tmp();
  inbox = tmp();
});
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

/** every file below a folder, relative with forward slashes, sorted */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relExportPath(root, p));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
const bankFiles = (root = store) => tree(join(root, 'banks'));
const archive = (root = store) => tree(join(root, '_archiv'));
const read = (rel: string, root = store) => readFileSync(join(root, ...rel.split('/')), 'utf-8');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const put = (rel: string, data: Buffer | string, root = inbox) => {
  const p = join(root, ...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
  return p;
};
/** folder listing with sizes and mtimes: must not change */
function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      out.push(`${relExportPath(root, p)}|${st.isDirectory() ? 'dir' : st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}
const NO_SETTLE = { settleMs: 0 };
async function scan() {
  const before = listing(inbox);
  const r = await loadExportsForSnapshot(store, inbox, NO_SETTLE);
  expect(listing(inbox)).toEqual(before);
  return r;
}
async function upload(name: string, data: Buffer, mode: 'merge' | 'keepExisting' | 'replaceAll' = 'merge') {
  const preview = await previewUpload(store, name, data);
  const result = await commitImport(preview.id, mode, undefined, store);
  return { preview, result };
}
const bankLedger = () => buildBankLedger(classifyExportFiles(store).files.map((p) => ({ name: relExportPath(store, p), data: new Uint8Array(readFileSync(p)) })));
const acct = (l: ReturnType<typeof bankLedger>) => l.accounts.get(ID)!;
const money = (n: number) => Math.round(n * 100) / 100;

// ---------- the RB fee column (CSV) ----------

describe('RB fee ("Poplatky") as a separate movement', () => {
  it('CSV: a fee becomes a movement of its own with bankType Poplatek', () => {
    const [t] = readBankTables('a.csv', new Uint8Array(rbCsvText([{ id: 'C1', date: '2025-01-20', amount: -200, fee: -5, type: 'Platba kartou', merchant: 'KAVARNA' }])));
    const { txs } = bankTxsFromTable(t);
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ amount: -200, source: 'csv', bankTxId: 'C1' });
    expect(txs[1]).toMatchObject({ amount: -5, bankType: 'Poplatek', source: 'csv', bankTxId: 'C1' });
    expect(txs[1].key).toBe(`${txs[0].key}#fee`);
    expect(txs[1].message).toContain('Platba kartou');
  });

  it('CSV: no fee, no extra movement; a zero fee is ignored', () => {
    const [t] = readBankTables('a.csv', new Uint8Array(rbCsvText([{ id: 'C1', date: '2025-01-20', amount: -200 }, { id: 'C2', date: '2025-01-21', amount: -1, fee: 0 }])));
    expect(bankTxsFromTable(t).txs).toHaveLength(2);
  });
});

// ---------- importer ----------

describe('importing RB PDF statements', () => {
  it('previews and commits a zip: unit, periods, gap for the missing month, storage layout', async () => {
    const z = await zipOf({ 'vypis_01.pdf': pdf(JAN), 'vypis_03.pdf': pdf(MAR) });
    const p = await previewUpload(store, 'vypisy.zip', z);
    expect(p.units).toHaveLength(1);
    expect(p.units[0].unit).toBe(`${UNIT}/pdf`);
    expect(p.units[0].plan.newGaps).toEqual([{ from: '2025-02-01', to: '2025-02-28' }]);
    expect(p.units[0].warnings.some((w) => w.includes('chybí období'))).toBe(true);
    const r = await commitImport(p.id, 'merge', undefined, store);
    expect(r.written.length).toBeGreaterThan(0);
    expect(bankFiles()).toEqual([
      `rb/${ACC}/2025/statement-transactions.csv`,
      `rb/${ACC}/2025/statements/vypis_2025-01-01_2025-01-31_1.pdf`,
      `rb/${ACC}/2025/statements/vypis_2025-03-01_2025-03-31_3.pdf`,
      `rb/${ACC}/balances.csv`,
      `rb/${ACC}/statements.csv`,
    ]);
    expect(read(`${UNIT}/balances.csv`).trim().split('\n').slice(2)).toEqual(['2024-12-31,1000', '2025-01-31,1295', '2025-02-28,1295', '2025-03-31,1595']);
    const stored = read(`${UNIT}/2025/statement-transactions.csv`);
    expect(stored.split('\n')[0]).toBe(`#myfin-bank,1,RB,${ACC},CZK,pdf`);
    expect(stored).not.toContain('123456XXXXXX7890');
    expect(stored).not.toContain('JAN TESTOVACI');
    expect(stored).toContain('KAVARNA');
    expect(read(`${UNIT}/statements.csv`).split('\n')[0]).toBe(`#myfin-bank,1,RB,${ACC},CZK,statements`);
    const info = (await loadExportsForSnapshot(store, inbox, NO_SETTLE)).storage.units.find((u) => u.unit === `${UNIT}/pdf`)!;
    expect(info.coverage).toEqual([
      { from: '2025-01-01', to: '2025-01-31' },
      { from: '2025-03-01', to: '2025-03-31' },
    ]);
    expect(info.label).toContain('PDF výpisy');
  });

  it('only PDF statements: the ledger has the movements (fee separate) and a verified balance without warnings', async () => {
    await upload('vypisy.zip', await zipOf({ 'a.pdf': pdf(JAN), 'b.pdf': pdf(FEB), 'c.pdf': pdf(MAR) }));
    const l = bankLedger();
    expect(l.warnings).toEqual([]);
    expect(l.txs.map((t) => [t.date, t.amount, t.source])).toEqual([
      ['2025-01-05', 500, 'pdf'],
      ['2025-01-20', -200, 'pdf'],
      ['2025-01-20', -5, 'pdf'],
      ['2025-03-05', 300, 'pdf'],
    ]);
    expect(l.txs.find((t) => t.bankType === 'Poplatek')!.key).toMatch(/#fee$/);
    const bp = acct(l).balancePoints;
    expect(bp[0]).toEqual({ date: '2024-12-31', balance: 1000 });
    expect(bp[bp.length - 1]).toEqual({ date: '2025-03-31', balance: 1595 });
    expect(money(1000 + l.txs.reduce((s, t) => s + t.amount, 0))).toBe(1595);
    // the card holder's name is not kept as the counterparty
    expect(l.txs.every((t) => t.cpName !== 'JAN TESTOVACI')).toBe(true);
    expect(l.txs.find((t) => t.amount === -200)).toMatchObject({ merchant: 'KAVARNA', city: 'BRNO' });
  });

  it('re-importing the same zip is unchanged and writes nothing; PDF copies are written once', async () => {
    const z = await zipOf({ 'a.pdf': pdf(JAN) });
    await upload('v.zip', z);
    const files = bankFiles();
    const stamp = (f: string) => statSync(join(store, 'banks', ...f.split('/'))).mtimeMs;
    const before = files.map(stamp);
    const p = await previewUpload(store, 'v2.zip', z);
    expect(p.units[0].plan).toMatchObject({ added: 0, removed: 0, unchanged: true });
    const r = await commitImport(p.id, 'merge', undefined, store);
    expect(r.written).toEqual([]);
    expect(r.archived).toEqual([]);
    expect(bankFiles()).toEqual(files);
    expect(bankFiles().map(stamp)).toEqual(before);
  });

  it('merge replaces only the statement periods; a corrected PDF archives the old copy', async () => {
    await upload('v.zip', await zipOf({ 'a.pdf': pdf(JAN), 'c.pdf': pdf(MAR) }));
    const corrected = stmt({ seq: 3, from: '2025-03-01', to: '2025-03-31', opening: 1295, txs: [tx('2025-03-06', '9000003', 300)] });
    const p = await previewUpload(store, 'mar.pdf', pdf(corrected));
    expect(p.units[0].plan.conflict).toBe(true);
    await commitImport(p.id, 'merge', undefined, store);
    const l = bankLedger();
    expect(l.txs.map((t) => t.date)).toEqual(['2025-01-05', '2025-01-20', '2025-01-20', '2025-03-06']);
    expect(read(`${UNIT}/statements.csv`).trim().split('\n')).toHaveLength(4);
    expect(archive().some((f) => f.endsWith('vypis_2025-03-01_2025-03-31_3.pdf'))).toBe(true);
    expect(sha(readFileSync(join(store, 'banks', 'rb', ACC, '2025', 'statements', 'vypis_2025-03-01_2025-03-31_3.pdf')))).toBe(sha(pdf(corrected)));
    expect(l.warnings).toEqual([]);
  });

  it('a single PDF and a statement without movements import fine', async () => {
    await upload('empty.pdf', pdf(stmt({ seq: 4, from: '2025-04-01', to: '2025-04-30', opening: 50 })));
    const l = bankLedger();
    expect(l.txs).toEqual([]);
    expect(acct(l).balancePoints).toEqual([
      { date: '2025-03-31', balance: 50 },
      { date: '2025-04-30', balance: 50 },
    ]);
  });

  it('a USD sub-account with the number of the CZK account is kept apart', async () => {
    const usd = stmt({ seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 10, currency: 'USD', txs: [tx('2025-01-07', '9100001', 5)] });
    await upload('v.zip', await zipOf({ 'czk.pdf': pdf(JAN), 'usd.pdf': pdf(usd) }));
    expect(bankFiles().filter((f) => f.endsWith('statement-transactions.csv'))).toEqual([`rb/${ACC}/2025/statement-transactions.csv`, `rb/${ACC}_USD/2025/statement-transactions.csv`]);
    const l = bankLedger();
    expect([...l.accounts.keys()].sort()).toEqual([ID, `${ID}/USD`]);
    expect(l.txs.filter((t) => t.accountId === `${ID}/USD`)).toHaveLength(1);
    expect(l.txs.filter((t) => t.accountId === ID)).toHaveLength(3);
    expect(l.warnings).toEqual([]);
  });

  it('a non-RB statement PDF alone is refused', async () => {
    await expect(previewUpload(store, 'x.pdf', pdf({ ...JAN, bankCode: '0100' }))).rejects.toThrow(/Raiffeisenbank/);
  });
});

// ---------- CSV + PDF ----------

describe('CSV export together with PDF statements', () => {
  // the CSV has the card payment (without merchant) with its fee, a February movement no statement
  // has, and the March movement; the statements cover January and March
  const csvRows: CsvRow[] = [
    { id: '9000002', date: '2025-01-20', amount: -200, fee: -5, type: 'Platba kartou' },
    { id: '9000009', date: '2025-02-10', amount: -40 },
    { id: '9000003', date: '2025-03-05', amount: 300 },
  ];

  it.each([
    ['PDF first', true],
    ['CSV first', false],
  ])('pairs the same movements (%s): no double counting, CSV values win, PDF fills the gaps', async (_n, pdfFirst) => {
    const zip = await zipOf({ 'a.pdf': pdf(JAN), 'c.pdf': pdf(MAR) });
    if (pdfFirst) {
      await upload('v.zip', zip);
      await upload('pohyby.csv', rbCsvText(csvRows));
    } else {
      await upload('pohyby.csv', rbCsvText(csvRows));
      await upload('v.zip', zip);
    }
    expect(bankFiles().filter((f) => /\/(statement-)?transactions\.csv$/.test(f))).toEqual([`rb/${ACC}/2025/statement-transactions.csv`, `rb/${ACC}/2025/transactions.csv`]);
    const l = bankLedger();
    expect(l.txs.map((t) => [t.date, t.amount, t.source])).toEqual([
      ['2025-01-05', 500, 'pdf'],
      ['2025-01-20', -200, 'both'],
      ['2025-01-20', -5, 'both'],
      ['2025-02-10', -40, 'csv'],
      ['2025-03-05', 300, 'both'],
    ]);
    // the CSV lacks the merchant and city: filled from the PDF; the PDF holder name stays out
    expect(l.txs.find((t) => t.amount === -200)).toMatchObject({ merchant: 'KAVARNA', city: 'BRNO', bankType: 'Platba kartou' });
    expect(l.warnings).toEqual([]);
    expect(acct(l).balancePoints.length).toBeGreaterThan(0);
  });

  it('a differing amount is reported and the CSV value is used', async () => {
    await upload('v.zip', await zipOf({ 'a.pdf': pdf(JAN) }));
    await upload('pohyby.csv', rbCsvText([{ id: '9000001', date: '2025-01-05', amount: 510 }]));
    const l = bankLedger();
    expect(l.txs.filter((t) => t.date === '2025-01-05')).toHaveLength(1);
    expect(l.txs.find((t) => t.date === '2025-01-05')!.amount).toBe(510);
    expect(l.warnings.some((w) => w.message.includes('liší částkou nebo datem') && w.source === ID)).toBe(true);
  });

  it('PDF-only movements before the CSV period are added, CSV-only movements after the last statement stay', async () => {
    await upload('pohyby.csv', rbCsvText([{ id: '9000009', date: '2025-02-10', amount: -40 }]));
    await upload('v.zip', await zipOf({ 'a.pdf': pdf(JAN) }));
    const l = bankLedger();
    expect(l.txs.map((t) => t.date)).toEqual(['2025-01-05', '2025-01-20', '2025-01-20', '2025-02-10']);
    expect(l.warnings).toEqual([]);
  });

  it('statement totals that do not match the movements raise a warning', async () => {
    // the statement states a higher income than its movements add up to
    await upload('v.pdf', pdf(stmt({ seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 1000, txs: [J1], income: 900 })));
    const l = bankLedger();
    expect(l.warnings.some((w) => w.message.includes('nesedí na jeho součty'))).toBe(true);
  });

  it('a movement missing from the data of a statement period is reported even when only the CSV has the period', async () => {
    // CSV lacks the card payment of January; the statement includes it, so the ledger is complete
    await upload('pohyby.csv', rbCsvText([{ id: '9000001', date: '2025-01-05', amount: 500 }]));
    await upload('v.zip', await zipOf({ 'a.pdf': pdf(JAN) }));
    const l = bankLedger();
    expect(l.txs.filter((t) => t.date <= '2025-01-31')).toHaveLength(3);
    expect(l.warnings).toEqual([]);
  });
});

// ---------- the exports folder (inbox) ----------

describe('exports folder scan', () => {
  it('imports a zip of statements automatically, never writes to the folder, and is stable on the next scan', async () => {
    put('vypisy.zip', await zipOf({ 'a.pdf': pdf(JAN), 'c.pdf': pdf(MAR) }));
    put('pohyby.csv', rbCsvText([{ id: '9000009', date: '2025-02-10', amount: -40 }]));
    const r1 = await scan();
    const st = (path: string) => r1.storage.inbox.find((f) => f.path === path)?.status;
    expect(st('vypisy.zip')).toBe('imported');
    expect(st('pohyby.csv')).toBe('imported');
    expect(bankLedger().txs.map((t) => t.source)).toEqual(['pdf', 'pdf', 'pdf', 'csv', 'pdf']);
    const files = bankFiles();
    const r2 = await scan();
    expect(r2.storage.inbox.every((f) => f.status === 'unchanged' || f.status === 'imported')).toBe(true);
    expect(bankFiles()).toEqual(files);
  });

  it('a non-RB PDF becomes "unsupported", is not read again, and the folder is untouched', async () => {
    put('faktura.pdf', pdf({ ...JAN, bankCode: '0100' }));
    const r1 = await scan();
    expect(r1.storage.inbox.find((f) => f.path === 'faktura.pdf')!.status).toBe('unsupported');
    type Entry = { path: string; status: string; at: string; message: string };
    const manifest = () => Object.values(JSON.parse(read(MANIFEST_FILE)).files as Record<string, Entry>).find((e) => e.path === 'faktura.pdf')!;
    const first = manifest();
    expect(first.status).toBe('unsupported');
    expect(first.message).toMatch(/Raiffeisenbank/);
    await new Promise((r) => setTimeout(r, 15));
    const r2 = await scan();
    expect(r2.storage.inbox.find((f) => f.path === 'faktura.pdf')!.status).toBe('unsupported');
    expect(manifest().at).toBe(first.at); // not read and judged again
    expect(bankFiles()).toEqual([]);
  });

  it('a damaged .pdf is unsupported and not read again', async () => {
    put('rozbity.pdf', Buffer.from('%PDF-1.4 garbage'));
    const r1 = await scan();
    expect(r1.storage.inbox.find((f) => f.path === 'rozbity.pdf')!.status).toBe('unsupported');
    type Entry = { path: string; at: string };
    const entry = () => Object.values(JSON.parse(read(MANIFEST_FILE)).files as Record<string, Entry>).find((e) => e.path === 'rozbity.pdf')!;
    const at = entry().at;
    await new Promise((r) => setTimeout(r, 15));
    expect((await scan()).storage.inbox.find((f) => f.path === 'rozbity.pdf')!.status).toBe('unsupported');
    expect(entry().at).toBe(at);
    expect(bankFiles()).toEqual([]);
  });

  it('a zip bomb with a PDF entry in the folder is unsupported', async () => {
    const z = new JSZip();
    z.file('bomb.pdf', Buffer.alloc(210 * 1024 * 1024), { compression: 'DEFLATE', compressionOptions: { level: 9 } });
    put('bomb.zip', await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
    expect((await scan()).storage.inbox.find((f) => f.path === 'bomb.zip')!.status).toBe('unsupported');
    expect(bankFiles()).toEqual([]);
  }, 120_000);

  it('storage units list the PDF unit but not an RB CSV unit that only has balances', async () => {
    put('vypisy.zip', await zipOf({ 'a.pdf': pdf(JAN) }));
    const units = (await scan()).storage.units.map((u) => u.unit);
    expect(units).toContain(`${UNIT}/pdf`);
    expect(units).not.toContain(UNIT);
  });
});
