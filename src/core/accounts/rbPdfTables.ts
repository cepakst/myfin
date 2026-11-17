/**
 * Raiffeisenbank PDF statements (a single PDF or a zip of them, as the internet banking downloads
 * them) -> one bank table per account. The movements are written in the columns of the RB CSV
 * export, so stored statement movements and CSV movements are read by the same code and paired by
 * the transaction id. No file system access.
 */
import { addDays } from '../util.js';
import { readZipEntries, ZipLimitError } from '../zipEntries.js';
import type { ExportTable } from '../exportTables.js';
import { makeTable, statementKey } from './bankTables.js';
import { isPdf, pdfPages } from './pdfText.js';
import { NotRbStatementError, parseRbStatement, RbStatementFormatError, type RbPdfTx, type RbStatement } from './rbPdf.js';
import type { BalancePoint, StatementSummary } from './types.js';

/** Stored columns: the RB CSV export's names, plus the exchange rate and the merchant's country. */
export const RB_PDF_COLUMNS = [
  'Datum zaúčtování',
  'Datum provedení',
  'Id transakce',
  'Kategorie transakce',
  'Číslo protiúčtu',
  'Název protiúčtu',
  'Typ transakce',
  'Zpráva',
  'Poznámka',
  'VS',
  'KS',
  'SS',
  'Poplatky',
  'Zaúčtovaná částka',
  'Měna účtu',
  'Původní částka',
  'Původní měna',
  'Kurz',
  'Název obchodníka',
  'Město',
  'Země',
];

/** monthly statements of a few accounts over many years */
const MAX_ZIP_ENTRIES = 600;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;

/** The file is a PDF, or a zip whose first file (folders skipped) is a PDF. */
export function looksLikePdfStatements(name: string, data: Uint8Array): boolean {
  if (isPdf(data) || /\.pdf$/i.test(name)) return true;
  // zip local file headers: "PK\x03\x04", compressed size at 18, name length at 26, extra length at
  // 28, name at 30; the first file that is not a folder decides
  let off = 0;
  while (off + 30 <= data.length && data[off] === 0x50 && data[off + 1] === 0x4b && data[off + 2] === 0x03 && data[off + 3] === 0x04) {
    const size = (data[off + 18] | (data[off + 19] << 8) | (data[off + 20] << 16)) + data[off + 21] * 0x1000000;
    const nameLen = data[off + 26] | (data[off + 27] << 8);
    const extraLen = data[off + 28] | (data[off + 29] << 8);
    const entry = new TextDecoder('utf-8').decode(data.subarray(off + 30, off + 30 + nameLen));
    if (!entry.endsWith('/')) return /\.pdf$/i.test(entry);
    off += 30 + nameLen + extraLen + size;
  }
  return false;
}

const czDate = (iso: string | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const numText = (n: number | undefined) => (n === undefined ? '' : String(n));

function txRow(t: RbPdfTx): string[] {
  return [
    czDate(t.date),
    czDate(t.valueDate),
    t.code ?? '',
    t.category ?? '',
    t.cpAccount ?? '',
    t.cpName ?? '',
    t.type ?? '',
    t.message ?? '',
    t.note ?? '',
    t.vs ?? '',
    t.ks ?? '',
    t.ss ?? '',
    numText(t.fee),
    numText(t.amount),
    t.currency,
    numText(t.origAmount),
    t.origCurrency ?? '',
    numText(t.rate),
    t.merchant ?? '',
    t.city ?? '',
    t.country ?? '',
  ];
}

/** Statements of one account -> a table authoritative for the statement periods. */
function statementsTable(sts: RbStatement[], sources: Map<RbStatement, Uint8Array>): ExportTable {
  const sorted = [...sts].sort((a, b) => (a.from === b.from ? a.seq - b.seq : a.from < b.from ? -1 : 1));
  const first = sorted[0];
  const rows: string[][] = [];
  const seenCodes = new Set<string>();
  const balances: BalancePoint[] = [];
  const warnings: string[] = [];
  let outside = 0;
  for (const s of sorted) {
    warnings.push(...s.warnings);
    // the opening balance is the balance at the start of the first day = end of the previous day
    balances.push({ date: addDays(s.from, -1), balance: s.opening }, { date: s.to, balance: s.closing });
    const own = new Set<string>();
    for (const t of s.txs) {
      // the same movement in two overlapping statements (a code repeated within one statement stays)
      if (t.code && seenCodes.has(t.code)) continue;
      // the export is authoritative only for its statement periods (see mergeRecords)
      if (t.date < s.from || t.date > s.to) {
        outside++;
        continue;
      }
      if (t.code) own.add(t.code);
      rows.push(txRow(t));
    }
    for (const c of own) seenCodes.add(c);
  }
  if (outside) warnings.push(`${outside} pohybů s datem mimo období svého výpisu bylo vynecháno.`);
  const t = makeTable('RB', { number: first.number, currency: first.currency }, RB_PDF_COLUMNS, rows, {
    kind: 'BANK_RB_PDF',
    declaredRange: { from: sorted[0].from, to: sorted.reduce((m, s) => (s.to > m ? s.to : m), sorted[0].to) },
    balances,
    warnings,
  });
  t.periods = sorted.map((s) => ({ from: s.from, to: s.to }));
  t.statements = sorted.map(
    (s): StatementSummary => ({ seq: s.seq, from: s.from, to: s.to, opening: s.opening, closing: s.closing, income: s.income, expense: s.expense, fees: s.fees, txCount: s.txCount }),
  );
  t.attachments = sorted.map((s) => ({ path: `${s.to.slice(0, 4)}/statements/vypis_${s.from}_${s.to}_${s.seq}.pdf`, data: sources.get(s)! }));
  return t;
}

/**
 * RB PDF statement(s) -> one table per account. A file that is not an RB account statement (e.g. a
 * fee statement in the same zip) is skipped with a warning; throws NotRbStatementError when nothing
 * in the file is a statement.
 */
export async function readRbPdfTables(fileName: string, data: Uint8Array): Promise<ExportTable[]> {
  const pdfs: { name: string; data: Uint8Array }[] = [];
  if (isPdf(data)) pdfs.push({ name: fileName, data });
  else {
    try {
      pdfs.push(...(await readZipEntries(data, /\.pdf$/i, MAX_ZIP_ENTRIES, MAX_ZIP_BYTES)));
    } catch (e) {
      throw new NotRbStatementError(e instanceof ZipLimitError ? e.message : 'Soubor není PDF ani zip s PDF výpisy.');
    }
  }
  const statements: RbStatement[] = [];
  const sources = new Map<RbStatement, Uint8Array>();
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const p of pdfs) {
    let st: RbStatement;
    try {
      st = parseRbStatement(await pdfPages(p.data));
    } catch (e) {
      // a PDF that cannot be read (encrypted, damaged, too long) is not a statement the app knows:
      // reported once as unsupported instead of failing again on every scan
      if (pdfs.length > 1) {
        skipped.push(p.name);
        continue;
      }
      if (e instanceof NotRbStatementError || e instanceof RbStatementFormatError) throw e;
      // pdf.js failures (encrypted, damaged, too long): not a statement the app can read
      throw new NotRbStatementError(`PDF nelze přečíst (${(e as Error).name || 'chyba'}).`);
    }
    const k = `${st.number}|${st.currency}|${statementKey(st)}`;
    if (seen.has(k)) continue; // the same statement twice
    seen.add(k);
    statements.push(st);
    sources.set(st, p.data);
  }
  if (!statements.length) throw new NotRbStatementError(pdfs.length ? 'PDF není výpis z účtu Raiffeisenbank.' : 'Archiv neobsahuje žádné PDF.');
  const byAccount = new Map<string, RbStatement[]>();
  for (const s of statements) {
    const k = `${s.number}|${s.currency}`;
    const g = byAccount.get(k);
    if (g) g.push(s);
    else byAccount.set(k, [s]);
  }
  const tables = [...byAccount.values()].map((g) => statementsTable(g, sources));
  if (skipped.length) tables[0].warnings.push(`Přeskočeno ${skipped.length} PDF, které nejsou výpisem z účtu (např. výpis poplatků): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}.`);
  return tables;
}
