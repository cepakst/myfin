import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, ftruncateSync, utimesSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readXtbTables } from '../src/core/exportTables.js';
import { buildBankLedger } from '../src/core/accounts/ledger.js';
import { buildLedger } from '../src/core/parsers/index.js';
import type { Ledger } from '../src/core/types.js';
import {
  COVERAGE_FILE,
  MANIFEST_FILE,
  cancelImport,
  commitImport,
  ImportError,
  loadExportsForSnapshot,
  previewInbox,
  previewUpload,
  replanImport,
} from '../src/server/importer.js';
import { classifyExportFiles, listExportFiles, relExportPath } from '../src/server/store.js';
import { fioCsv, kbCsv, rbCsv, type BankRow } from './bankFixtures.js';

// ---------- synthetic Degiro data ----------

const TX_HEADER =
  'Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID';
const ACC_HEADER = 'Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id';

const num = (n: number) => `"${n.toFixed(2).replace('.', ',')}"`;
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

interface Tx {
  d: string;
  qty: number;
  price: number;
  order: string;
  isin?: string;
  name?: string;
  time?: string;
}
interface Acc {
  d: string;
  desc: string;
  amt: number;
  cur?: string;
  vd?: string;
  isin?: string;
  name?: string;
  time?: string;
  /** extra line without a date (wrapped description) */
  wrap?: string;
}

function txLine(t: Tx): string {
  const local = t.qty * t.price;
  return [
    dmy(t.d),
    t.time ?? '15:30',
    t.name ?? 'ACME CORP',
    t.isin ?? 'US0000000001',
    'NDQ',
    'XNAS',
    t.qty,
    num(t.price),
    'USD',
    num(-local),
    'USD',
    num(-local * 0.9),
    '"1,10"',
    '"-0,50"',
    '"-1,00"',
    num(-local * 0.9 - 1.5),
    t.order,
  ].join(',');
}

function accLines(a: Acc): string[] {
  const cur = a.cur ?? 'USD';
  const line = [dmy(a.d), a.time ?? '08:00', dmy(a.vd ?? a.d), a.name ?? '', a.isin ?? '', a.desc, '', cur, num(a.amt), cur, '"0,00"', ''].join(',');
  return a.wrap ? [line, `,,,,,${a.wrap},,,,,,`] : [line];
}

const byDateDesc = <T extends { d: string; time?: string }>(a: T, b: T) => `${b.d}T${b.time ?? ''}`.localeCompare(`${a.d}T${a.time ?? ''}`);
const txText = (rows: Tx[], header = TX_HEADER) => [header, ...[...rows].sort(byDateDesc).flatMap((r) => [txLine(r)])].join('\n') + '\n';
const accText = (rows: Acc[], header = ACC_HEADER) => [header, ...[...rows].sort(byDateDesc).flatMap(accLines)].join('\n') + '\n';

const TX: Tx[] = [
  { d: '2020-01-05', qty: 10, price: 100, order: 'ord-1' },
  { d: '2021-06-10', qty: 5, price: 120, order: 'ord-5' },
  { d: '2022-01-10', qty: 30, price: 8, order: 'ord-g00', isin: 'US0000000007', name: 'GAMA LTD' },
  { d: '2022-02-01', qty: -1, price: 10, order: 'ord-g01', isin: 'US0000000007', name: 'GAMA LTD' },
  { d: '2022-03-01', qty: -1, price: 10, order: 'ord-g02', isin: 'US0000000007', name: 'GAMA LTD' },
  { d: '2022-06-15', qty: -3, price: 130, order: 'ord-6' },
  { d: '2023-03-10', qty: 20, price: 50, order: 'ord-3', isin: 'US0000000004', name: 'BETA INC' },
  { d: '2024-02-15', qty: -4, price: 150, order: 'ord-2' },
  { d: '2024-09-20', qty: -20, price: 60, order: 'ord-4', isin: 'US0000000004', name: 'BETA INC' },
];

const ACC: Acc[] = [
  { d: '2020-01-02', desc: 'Deposit', amt: 2000, cur: 'EUR' },
  { d: '2022-04-01', desc: 'DEGIRO Exchange Connection Fee 2022 (Nasdaq)', amt: -2.5, cur: 'EUR' },
  { d: '2024-03-15', vd: '2024-03-14', desc: 'Dividend', amt: 6, isin: 'US0000000001', name: 'ACME CORP' },
  { d: '2024-03-15', vd: '2024-03-14', desc: 'Dividend Tax', amt: -0.9, isin: 'US0000000001', name: 'ACME CORP' },
  { d: '2024-09-15', vd: '2024-09-14', desc: 'Dividend', amt: 6, isin: 'US0000000001', name: 'ACME CORP' },
  { d: '2024-09-15', vd: '2024-09-14', desc: 'Dividend Tax', amt: -0.9, isin: 'US0000000001', name: 'ACME CORP' },
];

// ---------- helpers ----------

/** `store` = data/store, `inbox` = the user's (read-only) exports folder. */
let store: string;
let inbox: string;
const cleanup: string[] = [];

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'myfin-importer-test-'));
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

function put(rel: string, data: string | Buffer, root = inbox): string {
  const p = join(root, ...rel.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
  return p;
}
const read = (rel: string, root = store) => readFileSync(join(root, ...rel.split('/')), 'utf-8');
const storedFiles = (root = store) => listExportFiles(root).map((p) => relExportPath(root, p));
const archiveFiles = (root = store): string[] => {
  const a = join(root, '_archiv');
  if (!existsSync(a)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relExportPath(a, p));
    }
  };
  walk(a);
  return out.sort();
};

/** Every path (including `_` folders and unsupported files) with size and mtime. */
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
  if (existsSync(root)) walk(root);
  return out;
}
/** Store state without the manifest (rewritten with identical content on every scan). */
const storeState = (root = store) => listing(root).filter((l) => !l.startsWith(MANIFEST_FILE));

/** Runs an operation and asserts that the (read-only) exports folder is left byte- and mtime-identical. */
async function inboxUntouched<T>(fn: () => Promise<T>, root = inbox): Promise<T> {
  const before = listing(root);
  const r = await fn();
  expect(listing(root)).toEqual(before);
  return r;
}

// test files are written just before the scan; do not wait for them to settle
const NO_SETTLE = { settleMs: 0 };
const scan = (root = store, from = inbox) => inboxUntouched(() => loadExportsForSnapshot(root, from, NO_SETTLE), from);
const statusOf = (r: Awaited<ReturnType<typeof scan>>, path: string) => r.storage.inbox.find((f) => f.path === path)?.status;
const manifestOf = (root = store): Record<string, { path: string; status: string }> => {
  const p = join(root, MANIFEST_FILE);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')).files : {};
};

/** Fills a store with the given export files by scanning a throw-away exports folder. */
async function seed(files: Record<string, string | Buffer>, root = store): Promise<void> {
  const src = tmp();
  for (const [n, d] of Object.entries(files)) put(n, d, src);
  await loadExportsForSnapshot(root, src, NO_SETTLE);
}

async function ledgerOf(root = store): Promise<Ledger> {
  const files = classifyExportFiles(root).files.map((p) => ({ name: relExportPath(root, p), data: new Uint8Array(readFileSync(p)) }));
  return buildLedger(files);
}
async function ledgerOfTexts(files: Record<string, string | Buffer>): Promise<Ledger> {
  return buildLedger(Object.entries(files).map(([name, data]) => ({ name, data: new Uint8Array(typeof data === 'string' ? Buffer.from(data) : data) })));
}
const core = (l: Ledger) => ({ trades: l.trades, cash: l.cash, actions: l.actions, warnings: l.warnings.map((w) => w.message) });

async function upload(name: string, data: string | Buffer, mode?: 'merge' | 'keepExisting' | 'replaceAll', root = store) {
  const preview = await previewUpload(root, name, Buffer.from(data));
  const result = await commitImport(preview.id, mode ?? 'merge', undefined, root);
  return { preview, result };
}

const coverageOf = async (unit: string) => (await loadExportsForSnapshot(store, inbox, NO_SETTLE)).storage.units.find((u) => u.unit === unit);

const EXTRA: Tx = { d: '2024-01-10', qty: 2, price: 140, order: 'ord-x' };
/** 2024 rows without ord-2 plus one extra row: conflicts with the full history (ord-2 would be removed). */
const conflicting = () => txText([...TX.filter((t) => t.d >= '2024-01-01' && t.order !== 'ord-2'), EXTRA]);

// ---------- the exports folder (inbox) ----------

describe('scan of the exports folder', () => {
  it('imports full-history files, splits them by year, keeps the ledger identical and never writes to the inbox', async () => {
    const tx = txText(TX);
    const acc = accText(ACC);
    put('Transactions.csv', tx);
    put('Account.csv', acc);
    const r = await scan();
    expect(r.messages.filter((m) => m.startsWith('Importován soubor'))).toHaveLength(2);
    expect(r.storage.inbox.map((f) => `${f.path}:${f.status}`)).toEqual(['Account.csv:imported', 'Transactions.csv:imported']);
    expect(r.storage.storeDir).toBe(store);

    expect(storedFiles()).toEqual([
      'degiro/2020/Account.csv',
      'degiro/2020/Transactions.csv',
      'degiro/2021/Transactions.csv',
      'degiro/2022/Account.csv',
      'degiro/2022/Transactions.csv',
      'degiro/2023/Transactions.csv',
      'degiro/2024/Account.csv',
      'degiro/2024/Transactions.csv',
    ]);
    expect(existsSync(join(store, COVERAGE_FILE))).toBe(true);
    expect(existsSync(join(store, MANIFEST_FILE))).toBe(true);
    expect(readdirSync(inbox).sort()).toEqual(['Account.csv', 'Transactions.csv']);
    // files from the inbox are not copied into the archive
    expect(archiveFiles().some((f) => f.includes('import/'))).toBe(false);

    const orig = await ledgerOfTexts({ 'Transactions.csv': tx, 'Account.csv': acc });
    const split = await ledgerOf();
    expect(orig.trades).toHaveLength(9);
    expect(core(split)).toEqual(core(orig));
    // ids are content based, not line numbers
    expect(split.trades.map((t) => t.id)).toEqual(orig.trades.map((t) => t.id));
    expect(split.trades[0].id).toMatch(/^DEGIRO:2020-01-05T15:30:00:ord-1:US0000000001$/);
    expect(split.trades.find((t) => t.orderId === 'ord-1')!.fees.length).toBeGreaterThan(0);

    const info = r.storage.units.find((u) => u.unit === 'degiro/tx');
    expect(info!.coverage).toEqual([{ from: '2020-01-05', to: '2024-09-20' }]);
    expect(info!.years.map((y) => `${y.year}:${y.rows}`)).toEqual(['2020:1', '2021:1', '2022:4', '2023:1', '2024:2']);
  });

  it('a second scan imports nothing (manifest by content hash) and changes no stored file', async () => {
    put('Transactions.csv', txText(TX));
    put('Account.csv', accText(ACC));
    await scan();
    const state = storeState();
    expect(Object.keys(manifestOf())).toHaveLength(2);
    const r2 = await scan();
    expect(r2.messages).toEqual([]);
    expect(r2.storage.inbox.map((f) => f.status)).toEqual(['imported', 'imported']);
    expect(storeState()).toEqual(state);
    expect(archiveFiles()).toEqual([]);
  });

  it('a renamed or moved copy of an imported file is recognised by content', async () => {
    put('Transactions.csv', txText(TX));
    await scan();
    const state = storeState();
    put('sub/dir/copy.csv', txText(TX));
    const r = await scan();
    expect(statusOf(r, 'sub/dir/copy.csv')).toBe('imported');
    expect(r.messages).toEqual([]);
    expect(storeState()).toEqual(state);
  });

  it('a new partial file with only new rows is merged automatically', async () => {
    put('Transactions.csv', txText(TX.filter((t) => t.d < '2024-01-01')));
    await scan();
    put('2024.csv', txText(TX.filter((t) => t.d >= '2024-01-01')));
    const r = await scan();
    expect(statusOf(r, '2024.csv')).toBe('imported');
    expect(r.messages.some((m) => m.includes('2024.csv') && m.includes('nových řádků: 2'))).toBe(true);
    expect(storedFiles()).toContain('degiro/2024/Transactions.csv');
    expect((await ledgerOf()).trades).toHaveLength(9);
  });

  it('overlapping partial exports are imported without a conflict regardless of file names', async () => {
    // "a-" sorts first but holds the newer period
    put('a-newer.csv', txText(TX.filter((t) => t.d >= '2022-02-01')));
    put('b-older.csv', txText(TX.filter((t) => t.d <= '2022-03-01')));
    const r = await scan();
    expect(r.storage.inbox.map((f) => f.status)).toEqual(['imported', 'imported']);
    expect(r.messages.filter((m) => m.includes('čeká'))).toEqual([]);
    const full = await ledgerOfTexts({ 'Transactions.csv': txText(TX) });
    expect((await ledgerOf()).trades).toEqual(full.trades);
  });

  it('a conflicting file becomes pending, is reported and changes nothing in the store', async () => {
    put('Transactions.csv', txText(TX));
    await scan();
    const state = storeState();
    put('partial.csv', conflicting());
    const r = await scan();
    expect(statusOf(r, 'partial.csv')).toBe('pending');
    expect(r.messages.some((m) => m.includes('partial.csv') && m.includes('čeká na rozhodnutí'))).toBe(true);
    expect(storeState()).toEqual(state);
    expect((await ledgerOf()).trades.map((t) => t.orderId)).toContain('ord-2');
    // pending files are re-evaluated on every scan (and stay pending, store untouched)
    expect(statusOf(await scan(), 'partial.csv')).toBe('pending');
    expect(storeState()).toEqual(state);
  });

  it('previewInbox + commit resolves a pending file to imported', async () => {
    put('Transactions.csv', txText(TX));
    await scan();
    put('partial.csv', conflicting());
    expect(statusOf(await scan(), 'partial.csv')).toBe('pending');

    const p = await inboxUntouched(() => previewInbox(store, inbox, 'partial.csv'));
    expect(p.conflict).toBe(true);
    expect(p.units[0].plan).toMatchObject({ added: 1, removed: 1 });
    await inboxUntouched(() => commitImport(p.id, 'merge', undefined, store));
    const orders = (await ledgerOf()).trades.map((t) => t.orderId);
    expect(orders).toContain('ord-x');
    expect(orders).not.toContain('ord-2');
    // no copy of an inbox file in the archive, only the replaced year file
    expect(archiveFiles().some((f) => f.includes('import/'))).toBe(false);
    expect(archiveFiles().some((f) => f.endsWith('degiro/2024/Transactions.csv'))).toBe(true);

    const r = await scan();
    expect(statusOf(r, 'partial.csv')).toBe('imported');
    expect(r.messages.some((m) => m.includes('čeká'))).toBe(false);
  });

  it('cancelImport marks an inbox file as skipped; it is not offered again, but can be imported later', async () => {
    put('Transactions.csv', txText(TX));
    await scan();
    put('partial.csv', conflicting());
    expect(statusOf(await scan(), 'partial.csv')).toBe('pending');
    const state = storeState();

    const p = await previewInbox(store, inbox, 'partial.csv');
    expect(await inboxUntouched(() => cancelImport(p.id))).toBe(true);
    await expect(commitImport(p.id, 'merge', undefined, store)).rejects.toMatchObject({ status: 404 });
    const r = await scan();
    expect(statusOf(r, 'partial.csv')).toBe('skipped');
    expect(r.messages.some((m) => m.includes('čeká'))).toBe(false);
    expect(Object.values(manifestOf()).find((e) => e.path === 'partial.csv')!.status).toBe('skipped');
    expect(storeState()).toEqual(state);
    // a second scan keeps it skipped
    expect(statusOf(await scan(), 'partial.csv')).toBe('skipped');

    // the user can still import it explicitly
    const again = await previewInbox(store, inbox, 'partial.csv');
    await commitImport(again.id, 'merge', undefined, store);
    expect(statusOf(await scan(), 'partial.csv')).toBe('imported');
    expect((await ledgerOf()).trades.map((t) => t.orderId)).not.toContain('ord-2');
  });

  it('cancelling an upload returns false and records nothing', async () => {
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX)));
    expect(await cancelImport(p.id)).toBe(false);
    expect(manifestOf()).toEqual({});
  });

  it('an uploaded file that was committed and later appears in the inbox is not imported again', async () => {
    await seed({ 'Transactions.csv': txText(TX.filter((t) => t.d < '2024-01-01')) });
    const part = txText(TX.filter((t) => t.d >= '2024-01-01'));
    await upload('2024.csv', part);
    expect(Object.values(manifestOf()).some((e) => e.path === '(nahráno) 2024.csv' && e.status === 'imported')).toBe(true);
    expect(archiveFiles().some((f) => f.endsWith('import/2024.csv'))).toBe(true);
    const state = storeState();

    put('downloads/2024.csv', part);
    const r = await scan();
    expect(statusOf(r, 'downloads/2024.csv')).toBe('imported');
    expect(r.messages).toEqual([]);
    expect(storeState()).toEqual(state);
    expect((await ledgerOf()).trades).toHaveLength(9);
  });

  it('an unknown file (bank statement) is unsupported and not recorded; folders starting with _ are ignored', async () => {
    put('bank.csv', 'Datum;Castka;Protiucet\n1.1.2024;100;123\n');
    put('_old/Transactions.csv', txText(TX));
    put('notes.txt', 'hello');
    put('Transactions.csv', txText(TX.filter((t) => t.d < '2021-01-01')));
    const r = await scan();
    expect(r.storage.inbox.map((f) => `${f.path}:${f.status}`).sort()).toEqual(['Transactions.csv:imported', 'bank.csv:unsupported']);
    expect(Object.values(manifestOf()).map((e) => e.path)).toEqual(['Transactions.csv']);
    expect((await ledgerOf()).trades).toHaveLength(1);
    expect(statusOf(await scan(), 'bank.csv')).toBe('unsupported');
  });

  it('a missing inbox folder is not an error', async () => {
    const r = await loadExportsForSnapshot(store, join(inbox, 'does-not-exist'), NO_SETTLE);
    expect(r.storage.inbox).toEqual([]);
    expect(r.messages).toEqual([]);
  });

  it('a file without any data is reported as error', async () => {
    put('Transactions.csv', `${TX_HEADER}\n`);
    const r = await scan();
    expect(statusOf(r, 'Transactions.csv')).toBe('error');
  });
});

describe('scan robustness', () => {
  it('a file modified within the settle time is busy, not recorded, and imported by a later scan', async () => {
    put('Transactions.csv', txText(TX));
    const now = new Date();
    utimesSync(join(inbox, 'Transactions.csv'), now, now);
    const r = await inboxUntouched(() => loadExportsForSnapshot(store, inbox, { settleMs: 5000 }));
    expect(statusOf(r, 'Transactions.csv')).toBe('busy');
    expect(manifestOf()).toEqual({});
    expect(storedFiles()).toEqual([]);
    const r2 = await scan(); // settleMs 0
    expect(statusOf(r2, 'Transactions.csv')).toBe('imported');
    expect((await ledgerOf()).trades).toHaveLength(9);
  });

  it('a file larger than 100 MB is unsupported and not read or recorded', async () => {
    const p = put('huge.csv', 'x');
    const fd = openSync(p, 'r+');
    ftruncateSync(fd, 101 * 1024 * 1024);
    closeSync(fd);
    const r = await scan();
    expect(statusOf(r, 'huge.csv')).toBe('unsupported');
    expect(manifestOf()).toEqual({});
  });

  it('error entries are retried on the next scan, and failing files are listed in messages', async () => {
    const tx = txText(TX);
    put('Transactions.csv', tx);
    const hash = createHash('sha256').update(Buffer.from(tx)).digest('hex');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, MANIFEST_FILE), JSON.stringify({ version: 1, files: { [hash]: { path: 'Transactions.csv', status: 'error', at: new Date().toISOString(), message: 'boom' } } }));
    const r = await scan();
    expect(statusOf(r, 'Transactions.csv')).toBe('imported');
    expect((await ledgerOf()).trades).toHaveLength(9);

    put('empty.csv', `${TX_HEADER}
`);
    const r2 = await scan();
    expect(statusOf(r2, 'empty.csv')).toBe('error');
    expect(r2.messages.some((m) => m.startsWith('empty.csv:') && m.includes('import se nezdařil'))).toBe(true);
    // still retried (and reported) every time
    expect((await scan()).messages.some((m) => m.startsWith('empty.csv:'))).toBe(true);
  });

  it('two identical files in one scan: imported once, both shown as imported', async () => {
    put('a.csv', txText(TX));
    put('b.csv', txText(TX));
    const r = await scan();
    expect(r.storage.inbox.map((f) => `${f.path}:${f.status}`)).toEqual(['a.csv:imported', 'b.csv:imported']);
    const imp = r.messages.filter((m) => m.startsWith('Importován soubor'));
    expect(imp).toHaveLength(1);
    expect(imp[0]).toContain('nových řádků: 9');
    expect(archiveFiles()).toEqual([]); // nothing replaced, so the store was written only once
    expect((await ledgerOf()).trades).toHaveLength(9);
    expect(Object.keys(manifestOf())).toHaveLength(1);
  });

  it('newest export first: a newer export that corrects a row is imported, the older overlapping one becomes pending', async () => {
    const corrected = TX.filter((t) => t.d >= '2022-02-01').map((t) => (t.order === 'ord-g02' ? { ...t, price: 11 } : t));
    put('N-newer.csv', txText(corrected));
    put('O-older.csv', txText(TX.filter((t) => t.d <= '2022-03-01')));
    const r = await scan();
    expect(statusOf(r, 'N-newer.csv')).toBe('imported');
    expect(statusOf(r, 'O-older.csv')).toBe('pending');
    const g02 = (await ledgerOf()).trades.find((t) => t.orderId === 'ord-g02')!;
    expect(g02.price).toBe(11);
    expect(r.messages.some((m) => m.includes('O-older.csv') && m.includes('čeká na rozhodnutí'))).toBe(true);
  });

  it('a zip with two workbooks of the same account is rejected on preview', async () => {
    const zip = new JSZip();
    zip.file('CZK_12345_2023-11-01_2024-03-31.xlsx', await xtbBook({ from: '2023-11-01', to: '2024-03-31', rows: XTB_H1 }));
    zip.file('CZK_12345_2024-04-01_2024-06-30.xlsx', await xtbBook({ from: '2024-04-01', to: '2024-06-30', rows: XTB_H2 }));
    const data = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(previewUpload(store, 'xtb.zip', data)).rejects.toBeInstanceOf(ImportError);
    expect(storedFiles()).toEqual([]);
  });
});

describe('previewInbox path validation', () => {
  it('rejects paths outside the exports folder or not listed as export files', async () => {
    put('Transactions.csv', txText(TX));
    put('x.csv', txText(TX), store); // exists next to the inbox (in the store), but is not in it
    await inboxUntouched(async () => {
      await expect(previewInbox(store, inbox, '../x.csv')).rejects.toMatchObject({ status: 404 });
      await expect(previewInbox(store, inbox, 'missing.csv')).rejects.toMatchObject({ status: 404 });
      await expect(previewInbox(store, inbox, join(inbox, 'Transactions.csv'))).rejects.toBeInstanceOf(ImportError);
    });
    const ok = await previewInbox(store, inbox, 'Transactions.csv');
    expect(ok.fileName).toBe('Transactions.csv');
    await cancelImport(ok.id);
  });

  it('an unsupported file in the inbox cannot be previewed', async () => {
    put('bank.csv', 'a;b\n1;2\n');
    await expect(previewInbox(store, inbox, 'bank.csv')).rejects.toBeInstanceOf(ImportError);
  });
});

// ---------- Degiro ----------

describe('one full export vs. overlapping partial exports', () => {
  it('gives an identical ledger without a conflict', async () => {
    const storeA = tmp();
    await seed({ 'Transactions.csv': txText(TX), 'Account.csv': accText(ACC) }, storeA);

    await seed({ 'Transactions.csv': txText(TX.filter((t) => t.d <= '2022-03-01')), 'Account.csv': accText(ACC.filter((t) => t.d <= '2022-04-01')) });

    const p1 = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX.filter((t) => t.d >= '2022-02-01'))));
    expect(p1.conflict).toBe(false);
    expect(p1.units[0].plan).toMatchObject({ removed: 0, unchanged: false });
    expect(p1.units[0].plan.added).toBe(TX.filter((t) => t.d >= '2022-03-02').length);
    await commitImport(p1.id, 'merge', undefined, store);
    const p2 = await previewUpload(store, 'Account.csv', Buffer.from(accText(ACC.filter((t) => t.d >= '2022-04-01'))));
    expect(p2.conflict).toBe(false);
    await commitImport(p2.id, 'merge', undefined, store);

    const a = await ledgerOf(storeA);
    const b = await ledgerOf(store);
    expect(core(b)).toEqual(core(a));
    expect(b.trades).toHaveLength(9);
    expect(b.cash.length).toBe(a.cash.length);
    expect((await coverageOf('degiro/tx'))!.coverage).toEqual([{ from: '2020-01-05', to: '2024-09-20' }]);
  });
});

describe('importing new and repeated exports', () => {
  beforeEach(async () => {
    await seed({ 'Transactions.csv': txText(TX.filter((t) => t.d < '2024-01-01')) });
  });

  it('new rows only: no conflict; re-import of the same file is unchanged and writes nothing', async () => {
    const part = txText(TX.filter((t) => t.d >= '2024-01-01'));
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(part));
    expect(p.conflict).toBe(false);
    expect(p.units[0].plan).toMatchObject({ added: 2, removed: 0, unchanged: false });
    const r = await commitImport(p.id, 'merge', undefined, store);
    expect(r.written).toEqual(['degiro/2024/Transactions.csv']);
    expect(r.archived).toEqual([]);

    const before = read('degiro/2024/Transactions.csv');
    const files = storedFiles();
    const again = await previewUpload(store, 'Transactions.csv', Buffer.from(part));
    expect(again.units[0].plan).toMatchObject({ added: 0, removed: 0, unchanged: true });
    expect(again.conflict).toBe(false);
    const r2 = await commitImport(again.id, 'merge', undefined, store);
    expect(r2.written).toEqual([]);
    expect(r2.archived).toEqual([]);
    expect(read('degiro/2024/Transactions.csv')).toBe(before);
    expect(storedFiles()).toEqual(files);
    // the copies of the uploaded originals are kept in the archive
    expect(archiveFiles().filter((f) => f.endsWith('import/Transactions.csv')).length).toBeGreaterThanOrEqual(2);
    expect((await ledgerOf()).trades).toHaveLength(9);
  });

  it('cancelled import writes nothing and the staged id expires', async () => {
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX.filter((t) => t.d >= '2024-01-01'))));
    await cancelImport(p.id);
    await expect(commitImport(p.id, 'merge', undefined, store)).rejects.toMatchObject({ status: 404 });
    expect((await ledgerOf()).trades).toHaveLength(7);
    expect(archiveFiles().some((f) => f.includes('import/'))).toBe(false);
  });

  it('warns about a gap between stored data and the new export', async () => {
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX.filter((t) => t.d >= '2024-01-01'))));
    expect(p.units[0].plan.newGaps).toEqual([{ from: '2023-03-11', to: '2024-02-14' }]);
    expect(p.units[0].warnings.some((w) => w.includes('chybí období'))).toBe(true);
    await cancelImport(p.id);
  });
});

describe('conflicts', () => {
  beforeEach(async () => {
    await seed({ 'Transactions.csv': txText(TX) });
  });

  it('is reported when a stored row in the range is missing from the export', async () => {
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(conflicting()));
    expect(p.conflict).toBe(true);
    expect(p.units[0].plan).toMatchObject({ added: 1, removed: 1 });
    const y2024 = p.units[0].plan.years.find((y) => y.year === 2024)!;
    expect(y2024).toMatchObject({ stored: 2, incoming: 2 });
    expect(y2024.result).toEqual({ merge: 2, keepExisting: 2, replaceAll: 2 });
    await cancelImport(p.id);
  });

  it('merge: the export is authoritative in its range', async () => {
    await upload('Transactions.csv', conflicting(), 'merge');
    const l = await ledgerOf();
    const orders = l.trades.map((t) => t.orderId);
    expect(orders).not.toContain('ord-2');
    expect(orders).toContain('ord-x');
    expect(orders).toContain('ord-1'); // outside the range, untouched
    expect(l.trades).toHaveLength(9);
    expect(archiveFiles().some((f) => f.endsWith('degiro/2024/Transactions.csv'))).toBe(true);
    expect((await coverageOf('degiro/tx'))!.coverage).toEqual([{ from: '2020-01-05', to: '2024-09-20' }]);
  });

  it('keepExisting: stored rows stay, nothing inside the stored coverage is added', async () => {
    const before = read('degiro/2024/Transactions.csv');
    const { result } = await upload('Transactions.csv', conflicting(), 'keepExisting');
    expect(result.written).toEqual([]);
    expect(read('degiro/2024/Transactions.csv')).toBe(before);
    const orders = (await ledgerOf()).trades.map((t) => t.orderId);
    expect(orders).toContain('ord-2');
    expect(orders).not.toContain('ord-x');
  });

  it('replaceAll: the export becomes the whole history and the coverage shrinks to its range', async () => {
    const { result } = await upload('Transactions.csv', conflicting(), 'replaceAll');
    expect(storedFiles()).toEqual(['degiro/2024/Transactions.csv']);
    expect(result.archived).toContain('degiro/2020/Transactions.csv');
    expect(archiveFiles().some((f) => f.endsWith('degiro/2020/Transactions.csv'))).toBe(true);
    const l = await ledgerOf();
    expect(l.trades.map((t) => t.orderId).sort()).toEqual(['ord-4', 'ord-x']);
    expect((await coverageOf('degiro/tx'))!.coverage).toEqual([{ from: '2024-01-10', to: '2024-09-20' }]);
  });
});

describe('widening the export period (replanImport)', () => {
  beforeEach(async () => {
    await seed({ 'Transactions.csv': txText(TX) });
  });

  it('counts stored rows that fall into the wider period as removed', async () => {
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX.filter((t) => t.d >= '2024-01-01'))));
    expect(p.units[0].plan).toMatchObject({ unchanged: true, removed: 0 });
    expect(p.units[0].range).toEqual({ from: '2024-02-15', to: '2024-09-20' });
    const wide = await replanImport(p.id, { from: '2023-01-01', to: '2024-12-31' });
    expect(wide.units[0].plan.removed).toBe(1); // BETA buy on 2023-03-10
    expect(wide.conflict).toBe(true);
    const r = await commitImport(p.id, 'merge', { from: '2023-01-01', to: '2024-12-31' }, store);
    expect(r.units[0].removed).toBe(1);
    expect((await ledgerOf()).trades.map((t) => t.orderId)).not.toContain('ord-3');
  });

  it('rejects a period that does not cover the rows of the export', async () => {
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX.filter((t) => t.d >= '2024-01-01'))));
    await expect(replanImport(p.id, { from: '2024-03-01', to: '2024-12-31' })).rejects.toBeInstanceOf(ImportError);
    await expect(replanImport(p.id, { from: '2024-01-01', to: '2024-06-01' })).rejects.toBeInstanceOf(ImportError);
    await expect(replanImport(p.id, { from: 'nonsense', to: '2024-06-01' })).rejects.toBeInstanceOf(ImportError);
    await expect(replanImport('missing-id', { from: '2024-01-01', to: '2024-12-31' })).rejects.toMatchObject({ status: 404 });
    await cancelImport(p.id);
  });
});

describe('identical duplicate rows', () => {
  it('survive split and merge (both trades present, count-aware comparison)', async () => {
    const dup: Tx = { d: '2023-03-10', qty: 5, price: 50, order: 'ord-dup', time: '10:00' };
    const rows = [...TX, dup, dup];
    await seed({ 'Transactions.csv': txText(rows) });
    let l = await ledgerOf();
    expect(l.trades.filter((t) => t.orderId === 'ord-dup')).toHaveLength(2);
    expect(l.trades.filter((t) => t.orderId === 'ord-dup').map((t) => t.id)).toEqual(['DEGIRO:2023-03-10T10:00:00:ord-dup:US0000000001', 'DEGIRO:2023-03-10T10:00:00:ord-dup:US0000000001#2']);

    // the same data once more: unchanged
    const same = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(rows)));
    expect(same.units[0].plan.unchanged).toBe(true);
    await cancelImport(same.id);

    // an export with only one of the two rows is a conflict (one stored row is missing)
    const one = await previewUpload(store, 'Transactions.csv', Buffer.from(txText([...TX.filter((t) => t.d >= '2023-01-01'), dup])));
    expect(one.conflict).toBe(true);
    expect(one.units[0].plan.removed).toBe(1);
    await cancelImport(one.id);

    // a partial export with both rows plus a new one merges without losing either
    await upload('Transactions.csv', txText([dup, dup, { d: '2023-04-01', qty: 1, price: 55, order: 'ord-new' }]));
    l = await ledgerOf();
    expect(l.trades.filter((t) => t.orderId === 'ord-dup')).toHaveLength(2);
    expect(l.trades.some((t) => t.orderId === 'ord-new')).toBe(true);
  });
});

describe('Degiro Account specifics', () => {
  const div = (d: string, vd: string, amt: number, time = '08:00'): Acc => ({ d, vd, desc: 'Dividend', amt, isin: 'US0000000001', name: 'ACME CORP', time });

  it('a dividend and its reversal booked in January (value date in December) still net after the split', async () => {
    const rows: Acc[] = [
      { d: '2023-12-20', desc: 'Deposit', amt: 100, cur: 'EUR' },
      div('2023-12-20', '2023-12-19', 10),
      div('2024-01-03', '2023-12-19', -10, '09:00'),
      div('2024-01-03', '2023-12-19', 12, '09:00'),
    ];
    const text = accText(rows);
    await seed({ 'Account.csv': text });
    expect(read('degiro/2023/Account.csv')).toContain('20-12-2023');
    expect(read('degiro/2024/Account.csv')).toContain('03-01-2024');
    expect(read('degiro/2024/Account.csv')).not.toContain('20-12-2023');

    const split = await ledgerOf();
    const orig = await ledgerOfTexts({ 'Account.csv': text });
    expect(core(split)).toEqual(core(orig));
    const d = split.cash.filter((c) => c.kind === 'DIVIDEND');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ amount: 12, date: '2023-12-19', currency: 'USD' });
  });

  it('a wrapped row with an empty date stays with its record and is part of its identity', async () => {
    const rows: Acc[] = [
      { d: '2022-04-01', desc: 'DEGIRO Exchange Connection Fee 2022 (Nasdaq)', amt: -2.5, cur: 'EUR', wrap: 'wrapped continuation' },
      { d: '2022-12-30', desc: 'Deposit', amt: 500, cur: 'EUR' },
      { d: '2023-01-02', desc: 'Deposit', amt: 100, cur: 'EUR' },
    ];
    const text = accText(rows);
    await seed({ 'Account.csv': text });
    const lines = read('degiro/2022/Account.csv').trim().split('\n');
    const i = lines.findIndex((l) => l.includes('Exchange Connection Fee'));
    expect(lines[i + 1]).toContain('wrapped continuation');
    expect(lines).toHaveLength(1 + 3); // header + 2 records + continuation line
    expect(core(await ledgerOf())).toEqual(core(await ledgerOfTexts({ 'Account.csv': text })));

    // same export again: unchanged; without the continuation it is a different row
    const same = await previewUpload(store, 'Account.csv', Buffer.from(text));
    expect(same.units[0].plan.unchanged).toBe(true);
    await cancelImport(same.id);
    const noWrap = await previewUpload(store, 'Account.csv', Buffer.from(accText(rows.map(({ wrap: _w, ...r }) => r))));
    expect(noWrap.units[0].plan.removed).toBe(1);
    await cancelImport(noWrap.id);
  });

  it('the running balance is not part of the row identity', async () => {
    await seed({ 'Account.csv': accText(ACC) });
    const changed = accText(ACC).replace(/"0,00",$/gm, '"123,45",');
    const p = await previewUpload(store, 'Account.csv', Buffer.from(changed));
    expect(p.units[0].plan).toMatchObject({ added: 0, removed: 0, unchanged: true });
    await cancelImport(p.id);
  });

  it('an export with different columns (other language) allows only replaceAll', async () => {
    await seed({ 'Transactions.csv': txText(TX) });
    const cz = TX_HEADER.replace('Date,Time,Product', 'Datum,Čas,Produkt').replace('Quantity', 'Počet');
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX.filter((t) => t.d >= '2024-01-01'), cz)));
    expect(p.units[0].allowedModes).toEqual(['replaceAll']);
    expect(p.conflict).toBe(true);
    expect(p.units[0].warnings.some((w) => w.includes('jiné sloupce'))).toBe(true);
    await expect(commitImport(p.id, 'merge', undefined, store)).rejects.toBeInstanceOf(ImportError);
    await expect(commitImport(p.id, 'keepExisting', undefined, store)).rejects.toBeInstanceOf(ImportError);
    // nothing was changed by the rejected commits
    expect(storedFiles()).toContain('degiro/2020/Transactions.csv');
    await commitImport(p.id, 'replaceAll', undefined, store);
    expect(storedFiles()).toEqual(['degiro/2024/Transactions.csv']);
  });

  it('a different-language file in the inbox becomes pending instead of being merged', async () => {
    await seed({ 'Transactions.csv': txText(TX) });
    const cz = TX_HEADER.replace('Date,Time,Product', 'Datum,Čas,Produkt').replace('Quantity', 'Počet');
    put('cz.csv', txText([{ d: '2025-02-01', qty: 1, price: 1, order: 'ord-cz' }], cz));
    const state = storeState();
    const r = await scan();
    expect(statusOf(r, 'cz.csv')).toBe('pending');
    expect(storeState()).toEqual(state);
  });
});

// ---------- XTB ----------

const utc = (iso: string) => new Date(`${iso.replace(' ', 'T')}:00Z`);
const XTB_HEADER = ['Type', 'Instrument', 'Ticker', 'Category', 'Time', 'Amount', 'ID', 'Comment'];

interface XtbRow {
  type: string;
  time: string;
  amount: number;
  id: string;
  ticker?: string;
  comment?: string;
}

async function xtbBook(opts: { from: string; to: string; rows: XtbRow[]; open?: { asOf: string; price: number; qty: number } }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash Operations');
  ws.addRow(['Account number', '12345']);
  ws.addRow(['Date from (UTC)', utc(`${opts.from} 00:00`)]);
  ws.addRow(['Date to (UTC)', utc(`${opts.to} 23:59`)]);
  ws.addRow(XTB_HEADER);
  for (const r of opts.rows) ws.addRow([r.type, r.ticker ? 'Acme' : '', r.ticker ?? '', r.ticker ? 'STOCK' : '', utc(r.time), r.amount, r.id, r.comment ?? r.type]);
  ws.addRow(['Total', '', '', '', '', opts.rows.reduce((s, r) => s + r.amount, 0), '', '']);
  if (opts.open) {
    const os = wb.addWorksheet('Open Positions');
    os.addRow(['As of', utc(opts.open.asOf)]);
    os.addRow(['Position', 'Ticker', 'Category', 'Volume', 'Current price', 'Value']);
    os.addRow(['Acme', 'ACME.US', 'STOCK', opts.open.qty, opts.open.price, opts.open.qty * opts.open.price * 20]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const XTB_H1: XtbRow[] = [
  { type: 'Deposit', time: '2023-11-02 09:00', amount: 10000, id: '1' },
  { type: 'Stock purchase', time: '2023-12-20 14:00', amount: -2300, id: '2', ticker: 'ACME.US', comment: 'OPEN BUY 5 @ 20.00' },
  { type: 'DIVIDENT', time: '2024-02-01 12:00', amount: 46, id: '3', ticker: 'ACME.US', comment: 'ACME.US USD 0.4000/ SHR' },
  { type: 'Withholding Tax', time: '2024-02-01 12:00', amount: -6.9, id: '4', ticker: 'ACME.US', comment: 'ACME.US USD WHT 15%' },
];
const XTB_H2: XtbRow[] = [{ type: 'Stock sale', time: '2024-05-10 14:00', amount: 1500, id: '5', ticker: 'ACME.US', comment: 'CLOSE BUY 3/5 @ 25.00' }];

describe('XTB', () => {
  it('splits by year keeping the currency prefix, drops the Total row and keeps open positions separately', async () => {
    const book = await xtbBook({ from: '2023-11-01', to: '2024-03-31', rows: XTB_H1, open: { asOf: '2024-03-31 20:00', price: 22, qty: 5 } });
    const baseline = await ledgerOfTexts({ 'CZK_12345_2023-11-01_2024-03-31.xlsx': book });
    put('CZK_12345_2023-11-01_2024-03-31.xlsx', book);
    const r = await scan();
    expect(r.messages.filter((m) => m.startsWith('Importován soubor'))).toHaveLength(1);

    expect(storedFiles()).toEqual([
      'xtb/12345/2023/CZK_12345_2023.xlsx',
      'xtb/12345/2024/CZK_12345_2024.xlsx',
      'xtb/12345/CZK_12345_open-positions.xlsx',
    ]);
    // Total row is not stored
    const y2024 = (await readXtbTables(new Uint8Array(readFileSync(join(store, 'xtb', '12345', '2024', 'CZK_12345_2024.xlsx'))), 'CZK_12345_2024.xlsx'))[0];
    expect(y2024.records).toHaveLength(2);
    const raw = new ExcelJS.Workbook();
    await raw.xlsx.readFile(join(store, 'xtb', '12345', '2024', 'CZK_12345_2024.xlsx'));
    const typesInFile: string[] = [];
    raw.worksheets[0].eachRow((row) => typesInFile.push(String(row.getCell(1).value)));
    expect(typesInFile.some((t) => /^total$/i.test(t))).toBe(false);
    expect(raw.worksheets.map((w) => w.name)).toEqual(['Cash Operations']);

    const l = await ledgerOf();
    expect(l.warnings).toEqual([]);
    expect(l.trades).toEqual(baseline.trades);
    expect(l.cash).toEqual(baseline.cash);
    expect(l.trades[0]).toMatchObject({ quantity: 5, price: 20, amountCzk: 2300, date: '2023-12-20' });
    expect(l.cash.every((c) => c.currency === 'CZK')).toBe(true);
    // quotes come from the separately stored open positions
    expect(l.brokerQuotes.get('XTB:ACME.US')).toMatchObject({ price: 22, quantity: 5, valueCzk: 2200 });

    const info = await coverageOf('xtb/12345');
    expect(info!.label).toContain('12345');
    expect(info!.coverage).toEqual([{ from: '2023-11-01', to: '2024-03-31' }]);
    expect(info!.years).toEqual([
      { year: 2023, rows: 2 },
      { year: 2024, rows: 2 },
    ]);
    expect(info!.openPositionsAsOf).toBe('2024-03-31 20:00:00');
  });

  it('a following export merges in; a newer open positions snapshot replaces the older one, an older one does not', async () => {
    await seed({ 'CZK_12345_2023-11-01_2024-03-31.xlsx': await xtbBook({ from: '2023-11-01', to: '2024-03-31', rows: XTB_H1, open: { asOf: '2024-03-31 20:00', price: 22, qty: 5 } }) });

    const h2 = await xtbBook({ from: '2024-04-01', to: '2024-06-30', rows: XTB_H2, open: { asOf: '2024-06-30 20:00', price: 30, qty: 2 } });
    const p = await previewUpload(store, 'CZK_12345_2024-04-01_2024-06-30.xlsx', h2);
    expect(p.conflict).toBe(false);
    expect(p.units[0].rangeEditable).toBe(false);
    expect(p.units[0].plan.newGaps).toEqual([]);
    const r = await commitImport(p.id, 'merge', undefined, store);
    expect(r.written).toContain('xtb/12345/CZK_12345_open-positions.xlsx');
    expect(r.archived).toContain('xtb/12345/CZK_12345_open-positions.xlsx');

    let l = await ledgerOf();
    expect(l.trades.map((t) => t.quantity)).toEqual([5, -3]);
    expect(l.brokerQuotes.get('XTB:ACME.US')).toMatchObject({ price: 30, quantity: 2 });
    expect((await coverageOf('xtb/12345'))!.openPositionsAsOf).toBe('2024-06-30 20:00:00');
    expect((await coverageOf('xtb/12345'))!.coverage).toEqual([{ from: '2023-11-01', to: '2024-06-30' }]);

    // an older snapshot (an earlier period re-imported) does not replace the newer one
    const old = await xtbBook({ from: '2023-11-01', to: '2024-03-31', rows: XTB_H1, open: { asOf: '2024-03-31 20:00', price: 1, qty: 1 } });
    const p2 = await previewUpload(store, 'CZK_12345_2023-11-01_2024-03-31.xlsx', old);
    expect(p2.units[0].plan.unchanged).toBe(true);
    await commitImport(p2.id, 'merge', undefined, store);
    l = await ledgerOf();
    expect(l.brokerQuotes.get('XTB:ACME.US')).toMatchObject({ price: 30, quantity: 2 });
  });

  it('a following XTB export in the inbox is merged automatically', async () => {
    put('h1.xlsx', await xtbBook({ from: '2023-11-01', to: '2024-03-31', rows: XTB_H1 }));
    await scan();
    put('h2.xlsx', await xtbBook({ from: '2024-04-01', to: '2024-06-30', rows: XTB_H2 }));
    const r = await scan();
    expect(r.storage.inbox.map((f) => f.status)).toEqual(['imported', 'imported']);
    expect((await ledgerOf()).trades.map((t) => t.quantity)).toEqual([5, -3]);
  });

  it('a stored XTB row missing in a re-imported period is a conflict (period comes from the export)', async () => {
    await seed({ 'CZK_12345_2023-11-01_2024-03-31.xlsx': await xtbBook({ from: '2023-11-01', to: '2024-03-31', rows: XTB_H1 }) });
    const less = await xtbBook({ from: '2023-11-01', to: '2024-03-31', rows: XTB_H1.slice(0, 3) });
    const p = await previewUpload(store, 'CZK_12345_2023-11-01_2024-03-31.xlsx', less);
    expect(p.conflict).toBe(true);
    expect(p.units[0].plan.removed).toBe(1);
    await cancelImport(p.id);
  });
});

describe('safety checks', () => {
  it('commit with a different store is rejected with 409 and writes nothing', async () => {
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX)));
    await expect(commitImport(p.id, 'merge', undefined, join(store, 'other'))).rejects.toMatchObject({ status: 409 });
    expect(storedFiles()).toEqual([]);
    expect(existsSync(join(store, 'other'))).toBe(false);
    await cancelImport(p.id);
  });
});

describe('review fixes', () => {
  it('two transaction rows that differ only by date are different records', async () => {
    const a: Tx = { d: '2023-03-10', qty: 5, price: 50, order: 'ord-same', time: '10:00' };
    const b: Tx = { ...a, d: '2023-03-11' };
    await seed({ 'Transactions.csv': txText([a]) });
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText([b])));
    expect(p.units[0].plan).toMatchObject({ added: 1, removed: 0 }); // the stored row is outside the export period
    const wide = await replanImport(p.id, { from: '2023-03-10', to: '2023-03-11' });
    expect(wide.units[0].plan).toMatchObject({ added: 1, removed: 1 }); // same content but another date is a different row
    await cancelImport(p.id);
  });

  it('an unreadable stored year file allows only replaceAll and is reported', async () => {
    await seed({ 'Transactions.csv': txText(TX) });
    writeFileSync(join(store, 'degiro', '2022', 'Transactions.csv'), 'garbage without header\n');
    const p = await previewUpload(store, 'Transactions.csv', Buffer.from(txText(TX.filter((t) => t.d >= '2024-01-01'))));
    expect(p.units[0].allowedModes).toEqual(['replaceAll']);
    await cancelImport(p.id);
    const snap = await loadExportsForSnapshot(store, inbox, NO_SETTLE);
    expect(snap.messages.some((m) => m.includes('nelze přečíst'))).toBe(true);
  });

  it('Degiro gaps of up to 10 days are not warned about, longer ones are', async () => {
    await seed({ 'Transactions.csv': txText(TX.filter((t) => t.d <= '2022-03-01')) });
    const short = await previewUpload(store, 'Transactions.csv', Buffer.from(txText([{ d: '2022-03-08', qty: 1, price: 1, order: 'o-s' }])));
    expect(short.units[0].warnings.some((w) => w.includes('chybí období'))).toBe(false);
    await cancelImport(short.id);
    const long = await previewUpload(store, 'Transactions.csv', Buffer.from(txText([{ d: '2022-06-08', qty: 1, price: 1, order: 'o-l' }])));
    expect(long.units[0].warnings.some((w) => w.includes('chybí období'))).toBe(true);
    await cancelImport(long.id);
  });
});

// ---------- bank statements (accounts module) ----------

describe('bank statements', () => {
  const FIO_ACC = '2101234567';
  const unitFio = `banks/fio/${FIO_ACC}`;
  const row = (id: string, date: string, amount: number, extra: Partial<BankRow> = {}): BankRow => ({ id, date, amount, type: 'Bezhotovostní příjem', ...extra });
  const sum = (rows: BankRow[]) => rows.reduce((s, r) => s + r.amount, 0);

  const DEC = [row('D1', '2024-12-10', 1000)];
  const JAN = [row('J1', '2025-01-05', 500), row('J2', '2025-01-20', -200, { type: 'Platba kartou' })];
  const FEB = [row('F1', '2025-02-05', 500)];
  const stmt = (from: string, to: string, open: number, rows: BankRow[], n = 1) => fioCsv({ account: FIO_ACC, n, from, to, open, close: open + sum(rows), rows });
  const sDec = () => stmt('2024-12-01', '2024-12-31', 0, DEC);
  const sJan = (rows = JAN) => stmt('2025-01-01', '2025-01-31', 1000, rows);
  const sFeb = () => stmt('2025-02-01', '2025-02-28', 1300, FEB);

  const bankLedgerOf = (root = store) =>
    buildBankLedger(classifyExportFiles(root).files.map((p) => ({ name: relExportPath(root, p), data: new Uint8Array(readFileSync(p)) })));
  const bankArchive = () => archiveFiles().filter((f) => f.includes('banks/'));

  it('monthly Fio statements imported one by one are split by year, contiguous and without gap warnings', async () => {
    for (const [name, text] of [['dec.csv', sDec()], ['jan.csv', sJan()], ['feb.csv', sFeb()]] as const) {
      const p = await previewUpload(store, name, Buffer.from(text));
      expect(p.conflict).toBe(false);
      expect(p.units[0].plan.newGaps).toEqual([]);
      expect(p.units[0].warnings.some((w) => w.includes('chybí období'))).toBe(false);
      expect(p.units[0].rangeEditable).toBe(false);
      await commitImport(p.id, 'merge', undefined, store);
    }
    expect(storedFiles()).toEqual([`${unitFio}/2024/transactions.csv`, `${unitFio}/2025/transactions.csv`, `${unitFio}/balances.csv`]);
    const info = await coverageOf(unitFio);
    expect(info!.coverage).toEqual([{ from: '2024-12-01', to: '2025-02-28' }]);
    expect(info!.years).toEqual([
      { year: 2024, rows: 1 },
      { year: 2025, rows: 3 },
    ]);
    expect(info!.label).toContain(FIO_ACC);
    // statement balances: the opening of a month equals the closing of the previous one (one point per day)
    const bal = read(`${unitFio}/balances.csv`).trim().split('\n');
    expect(bal[0]).toBe(`#myfin-bank,1,FIO,${FIO_ACC},CZK`);
    expect(bal.slice(2)).toEqual(['2024-11-30,0', '2024-12-31,1000', '2025-01-31,1300', '2025-02-28,1800']);
    const l = bankLedgerOf();
    expect(l.warnings).toEqual([]);
    expect(l.txs).toHaveLength(4);
    expect(l.txs.map((t) => t.amount)).toEqual([1000, 500, -200, 500]);
    // the year file only gained rows: it is replaced in place, not archived (bank kinds only)
    expect(bankArchive()).toEqual([]);
  });

  it('a missing month between statements is reported as a gap', async () => {
    await seed({ 'dec.csv': sDec() });
    const p = await previewUpload(store, 'feb.csv', Buffer.from(sFeb()));
    expect(p.units[0].plan.newGaps).toEqual([{ from: '2025-01-01', to: '2025-01-31' }]);
    expect(p.units[0].warnings.some((w) => w.includes('chybí období'))).toBe(true);
    await cancelImport(p.id);
  });

  it('re-importing the same statement is unchanged and writes nothing', async () => {
    await seed({ 'jan.csv': sJan() });
    const stable = () => storeState().filter((l) => !l.startsWith('_archiv') && !l.startsWith(COVERAGE_FILE));
    const before = stable();
    const p = await previewUpload(store, 'jan.csv', Buffer.from(sJan()));
    expect(p.units[0].plan).toMatchObject({ added: 0, removed: 0, unchanged: true });
    const r = await commitImport(p.id, 'merge', undefined, store);
    expect(r.written).toEqual([]);
    expect(r.archived).toEqual([]);
    expect(stable()).toEqual(before);
  });

  it('a later export of the same period with an extra row only adds it (no archive copy); a changed row is a conflict and the replaced year file is archived', async () => {
    await seed({ 'jan.csv': sJan() });
    const extra = row('J3', '2025-01-25', 50);
    const more = await upload('jan2.csv', sJan([...JAN, extra]));
    expect(more.preview.conflict).toBe(false);
    expect(more.preview.units[0].plan).toMatchObject({ added: 1, removed: 0 });
    expect(more.result.written).toContain(`${unitFio}/2025/transactions.csv`);
    // the statement states a different closing balance for the same day (the extra row), so only balances.csv is archived
    expect(bankArchive().filter((f) => f.endsWith('transactions.csv'))).toEqual([]);
    expect(more.result.archived).toEqual([`${unitFio}/balances.csv`]);
    expect(bankLedgerOf().txs).toHaveLength(3);

    const changed = [...JAN, { ...extra, amount: 60 }];
    const p = await previewUpload(store, 'jan3.csv', Buffer.from(sJan(changed)));
    expect(p.conflict).toBe(true);
    expect(p.units[0].plan).toMatchObject({ added: 1, removed: 1 });
    const r = await commitImport(p.id, 'merge', undefined, store);
    expect(r.archived).toContain(`${unitFio}/2025/transactions.csv`);
    expect(bankArchive().some((f) => f.endsWith(`${unitFio}/2025/transactions.csv`))).toBe(true);
    expect(bankLedgerOf().txs.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-200, 60, 500]);
  });

  it('a changed row in the inbox becomes pending and changes nothing', async () => {
    put('fio/jan.csv', sJan());
    await scan();
    const state = storeState();
    put('fio/jan-corrected.csv', sJan([JAN[0], { ...JAN[1], amount: -250 }]));
    const r = await scan();
    expect(statusOf(r, 'fio/jan-corrected.csv')).toBe('pending');
    expect(r.messages.some((m) => m.includes('jan-corrected.csv') && m.includes('čeká na rozhodnutí'))).toBe(true);
    expect(storeState()).toEqual(state);
  });

  it('an overlapping KB yearly export merges without duplicates (cp1250 diacritics survive)', async () => {
    const kbRows = (list: Omit<BankRow, 'type'>[]): BankRow[] => list.map((r) => ({ type: 'Odchozí úhrada', ...r }));
    const feb = kbRows([
      { id: 'K1', date: '2025-02-03', amount: 1000, cpName: 'ČEZ Prodej', message: 'Příliš žluťoučký kůň' },
      { id: 'K2', date: '2025-02-10', amount: -100 },
    ]);
    const jan = kbRows([{ id: 'K0', date: '2025-01-15', amount: -50 }]);
    await seed({ 'kb-feb.csv': kbCsv({ account: '19-2000145398', from: '2025-02-01', to: '2025-02-28', open: 500, close: 1400, rows: feb }) });
    const year = kbCsv({ account: '19-2000145398', from: '2025-01-01', to: '2025-12-31', open: 550, close: 1400, rows: [...jan, ...feb] });
    const p = await previewUpload(store, 'kb-year.csv', year);
    expect(p.conflict).toBe(false);
    expect(p.units[0].plan).toMatchObject({ added: 1, removed: 0 });
    expect(p.units[0].rangeEditable).toBe(false);
    await commitImport(p.id, 'merge', undefined, store);
    expect(storedFiles()).toEqual(['banks/kb/19-2000145398/2025/transactions.csv', 'banks/kb/19-2000145398/balances.csv']);
    const l = bankLedgerOf();
    expect(l.txs).toHaveLength(3);
    expect(l.txs.find((t) => t.bankTxId === 'K1')!.message).toBe('Příliš žluťoučký kůň');
    expect(l.txs.find((t) => t.bankTxId === 'K1')!.cpName).toBe('ČEZ Prodej');
    expect((await coverageOf('banks/kb/19-2000145398'))!.coverage).toEqual([{ from: '2025-01-01', to: '2025-12-31' }]);
    // the stored file is UTF-8
    expect(read('banks/kb/19-2000145398/2025/transactions.csv')).toContain('Příliš žluťoučký kůň');
  });

  it('Raiffeisenbank: the period is editable, a two-account file yields two units', async () => {
    const other: BankRow[] = [row('S1', '2025-03-31', 1000, { type: 'Inteligentní spoření - převod prostředků na spořicí účet' })];
    const text = rbCsv({ account: '1234567890', name: 'eKonto SMART', rows: [row('R1', '2025-03-02', -349, { type: 'Platba kartou', merchant: 'WOLT' })], other: { account: '1234567891', name: 'Spořicí účet', rows: other } });
    const p = await previewUpload(store, 'rb.csv', Buffer.from(text));
    expect(p.units).toHaveLength(2);
    for (const u of p.units) expect(u.rangeEditable).toBe(true);
    await commitImport(p.id, 'merge', undefined, store);
    expect(storedFiles()).toEqual(['banks/rb/1234567890/2025/transactions.csv', 'banks/rb/1234567891/2025/transactions.csv']);
    // RB exports carry no balance: no balances file
    expect(storedFiles().some((f) => f.endsWith('balances.csv'))).toBe(false);
    const l = bankLedgerOf();
    expect([...l.accounts.keys()].sort()).toEqual(['1234567890/5500', '1234567891/5500']);
    expect(l.accounts.get('1234567891/5500')!.name).toBe('Spořicí účet');
  });

  it('the exports folder (fio, kb, rb subfolders) is imported automatically and stays untouched', async () => {
    put('fio/Vypis_z_uctu-2101234567_20250101-20250131_cislo-1.csv', sJan());
    put('kb/Vypis_1.csv', kbCsv({ account: '19-2000145398', from: '2025-02-01', to: '2025-02-28', open: 0, close: 10, rows: [{ id: 'K1', date: '2025-02-03', amount: 10, type: 'Příchozí úhrada' }] }));
    put('rb/Pohyby_1234567890.csv', rbCsv({ account: '1234567890', name: 'eKonto', rows: [row('R1', '2025-03-02', -5, { type: 'Platba kartou' })] }));
    const r = await scan();
    expect(r.storage.inbox.map((f) => `${f.path}:${f.status}`)).toEqual([
      'fio/Vypis_z_uctu-2101234567_20250101-20250131_cislo-1.csv:imported',
      'kb/Vypis_1.csv:imported',
      'rb/Pohyby_1234567890.csv:imported',
    ]);
    expect(r.messages.filter((m) => m.startsWith('Importován soubor'))).toHaveLength(3);
    expect(bankLedgerOf().txs).toHaveLength(4);
    // the second scan is a no-op
    const state = storeState();
    expect((await scan()).messages).toEqual([]);
    expect(storeState()).toEqual(state);
  });

  it('a Fio statement without movements (balance only) still creates the account and its balances', async () => {
    await seed({ 'empty.csv': fioCsv({ account: '2109999999', from: '2025-01-01', to: '2025-01-31', open: 250, close: 250, rows: [] }) });
    expect(storedFiles()).toEqual(['banks/fio/2109999999/balances.csv']);
    const u = (await coverageOf('banks/fio/2109999999'))!;
    expect(u.label).toContain('2109999999');
    expect(u.years).toEqual([]);
    const l = bankLedgerOf();
    expect(l.txs).toEqual([]);
    expect(l.accounts.get('2109999999/2010')!.balancePoints).toEqual([
      { date: '2024-12-31', balance: 250 },
      { date: '2025-01-31', balance: 250 },
    ]);
  });

  it('bank files never reach the investment ledger and coexist with Degiro data', async () => {
    await seed({ 'Transactions.csv': txText(TX), 'jan.csv': sJan() });
    const l = await ledgerOf();
    expect(l.warnings).toEqual([]);
    expect(l.trades).toHaveLength(9);
    expect(storedFiles().filter((f) => f.startsWith('banks/'))).toHaveLength(2);
    const units = (await loadExportsForSnapshot(store, inbox, NO_SETTLE)).storage.units.map((u) => u.unit);
    expect(units).toContain('degiro/tx');
    expect(units).toContain(unitFio);
  });

  it('an unreadable bank file is rejected on upload with a clear error', async () => {
    const bad = '"Výpis č. 1/2025 z účtu ""x/2010"""\n"ID operace";"Datum";"Objem";"Měna"\n';
    await expect(previewUpload(store, 'bad.csv', Buffer.from(bad))).rejects.toBeInstanceOf(ImportError);
    expect(storedFiles()).toEqual([]);
  });
});
