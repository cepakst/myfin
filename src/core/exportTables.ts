/**
 * Reads broker exports into row-preserving tables (for splitting by year and merging) and writes
 * them back in the broker's own format, so the parsers read the stored year files unchanged.
 * No file system access – callers pass bytes in and get bytes/text out.
 */
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import type { DateRange, ExportRecord } from './exportStore.js';
import { isIsoDate } from './exportStore.js';
import { cellDate, cellText, headerIndex, loadXtbWorkbook, sheetRows } from './parsers/xtb.js';
import { dmyToIso, isoDateUtc, pad2 } from './util.js';

export type TableKind = 'DEGIRO_TX' | 'DEGIRO_ACCOUNT' | 'XTB' | BankTableKind;

/** Bank statements (accounts module), see accounts/bankTables.ts */
export type BankTableKind = 'BANK_FIO' | 'BANK_KB' | 'BANK_RB' | 'BANK_RB_PDF';

export interface ExportTable {
  /** storage unit: 'degiro/tx', 'degiro/account', 'xtb/<account>' or 'banks/<bank>/<account>' */
  unit: string;
  kind: TableKind;
  label: string;
  account?: string;
  currency?: string;
  /** rows written above the records; the last one is the column header */
  header: unknown[][];
  records: ExportRecord[];
  /** period stated in the export itself (XTB) */
  declaredRange?: DateRange;
  /** XTB "Open Positions" sheet (a snapshot on the report date) */
  openPositions?: { asOf: string; rows: unknown[][] };
  /**
   * periods the export is authoritative for when it consists of several statements (a zip of monthly
   * statements); defaults to the whole range
   */
  periods?: DateRange[];
  /** account balances stated in a bank statement (end of day) */
  balances?: { date: string; balance: number }[];
  /** statement summaries (RB PDF statements) */
  statements?: import('./accounts/types.js').StatementSummary[];
  /** source files kept next to the stored data (paths relative to the unit's folder) */
  attachments?: { path: string; data: Uint8Array }[];
  warnings: string[];
}

export const DEGIRO_FILE: Record<'DEGIRO_TX' | 'DEGIRO_ACCOUNT', string> = { DEGIRO_TX: 'Transactions.csv', DEGIRO_ACCOUNT: 'Account.csv' };

export const FIELD_SEP = '\u001f';
const ROW_SEP = '\u001e';

/** Account ids become folder names: keep them portable and outside the skipped "_" folders. */
export function safeAccount(raw: string | undefined): string {
  const a = (raw ?? '').trim().replace(/[^\w-]/g, '_').slice(0, 64);
  if (!/^[A-Za-z0-9][\w-]*$/.test(a) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(a)) return 'ucet';
  return a;
}

/** Years accepted from export rows (anything else is a malformed date). */
export function plausibleYear(date: string): boolean {
  const y = Number(date.slice(0, 4));
  return y >= 1990 && y <= 2100;
}

function findCol(header: string[], ...names: string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => h.trim().toLowerCase() === n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

export function degiroUnit(kind: 'DEGIRO_TX' | 'DEGIRO_ACCOUNT'): { unit: string; label: string } {
  return kind === 'DEGIRO_TX' ? { unit: 'degiro/tx', label: 'Degiro – transakce' } : { unit: 'degiro/account', label: 'Degiro – výpis z účtu' };
}

/** Header signature; files can be merged only when their columns are the same. */
export function headerSignature(t: Pick<ExportTable, 'header'>): string {
  const last = t.header[t.header.length - 1] ?? [];
  return last.map((c) => normCell(c).toLowerCase()).join(FIELD_SEP);
}

/** Degiro CSV -> records. Rows with an empty date belong to the preceding row (wrapped descriptions). */
export function readDegiroTable(text: string, kind: 'DEGIRO_TX' | 'DEGIRO_ACCOUNT'): ExportTable {
  const rows = parse(text.replace(/^﻿/, ''), { relax_column_count: true, skip_empty_lines: true }) as string[][];
  const header = rows[0] ?? [];
  const iDate = findCol(header, 'Date', 'Datum');
  const iTime = findCol(header, 'Time', 'Čas', 'Tijd');
  if (iDate < 0) throw new Error('Nerozpoznaná hlavička exportu Degiro (chybí sloupec Date/Datum)');
  // the running balance depends on rows outside the compared period, so it is not part of the row identity
  const iBal = kind === 'DEGIRO_ACCOUNT' ? findCol(header, 'Balance', 'Zůstatek', 'Saldo') : -1;
  const records: ExportRecord[] = [];
  let orphans: string[][] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const d = (r[iDate] ?? '').trim();
    if (!d) {
      if (records.length) records[records.length - 1].rows.push(r);
      else orphans.push(r);
      continue;
    }
    // footer / disclaimer lines carry text instead of a date – skip them like the parser does
    let date: string;
    try {
      date = dmyToIso(d);
    } catch {
      skipped++;
      continue;
    }
    if (!plausibleYear(date)) {
      skipped++;
      continue;
    }
    const time = ((iTime >= 0 ? r[iTime] : '') || '00:00').trim().padStart(5, '0');
    records.push({ date, sortKey: `${date}T${time}`, key: '', rows: [...orphans, r] });
    orphans = [];
  }
  for (const rec of records) {
    rec.key = rec.rows.map((r) => (r as string[]).map((c, i) => (iBal >= 0 && (i === iBal || i === iBal + 1) ? '' : (c ?? '').trim())).join(FIELD_SEP)).join(ROW_SEP);
  }
  const warnings: string[] = [];
  if (orphans.length) warnings.push(`${orphans.length} řádků bez data na konci souboru bylo vynecháno.`);
  if (skipped) warnings.push(`${skipped} řádků s neplatným datem bylo vynecháno.`);
  return { ...degiroUnit(kind), kind, header: [header], records, warnings };
}

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(header: unknown[][], records: readonly ExportRecord[]): string {
  const lines: string[] = [];
  for (const r of header) lines.push(r.map(csvField).join(','));
  for (const rec of records) for (const r of rec.rows) lines.push(r.map(csvField).join(','));
  return lines.join('\n') + '\n';
}

function roundToSecond(d: Date): Date {
  return new Date(Math.round(d.getTime() / 1000) * 1000);
}

/** "YYYY-MM-DD HH:MM:SS" in UTC; the XTB parser reads this format back as UTC. */
function xtbTime(d: Date): string {
  const x = roundToSecond(d);
  return `${isoDateUtc(x)} ${pad2(x.getUTCHours())}:${pad2(x.getUTCMinutes())}:${pad2(x.getUTCSeconds())}`;
}

/** Cell value as written to stored files: dates as UTC text, formulas as their result. */
function storedCell(v: unknown): unknown {
  if (v instanceof Date) return xtbTime(v);
  if (v && typeof v === 'object') {
    if ('result' in v) return storedCell((v as { result: unknown }).result);
    return cellText(v as ExcelJS.CellValue);
  }
  return v ?? null;
}

export function normCell(v: unknown): string {
  const s = storedCell(v);
  return s === null || s === undefined ? '' : String(s).trim();
}

function findLabelled(rows: ExcelJS.CellValue[][], label: RegExp): Date | null {
  for (const r of rows) {
    for (let j = 0; j < r.length; j++) {
      if (!label.test(cellText(r[j]))) continue;
      for (let k = j + 1; k < r.length; k++) {
        const d = cellDate(r[k]);
        if (d) return d;
      }
    }
  }
  return null;
}

/** XTB export (.zip with one or more account workbooks, or a single .xlsx) -> one table per account. */
export async function readXtbTables(data: Uint8Array, fileName: string): Promise<ExportTable[]> {
  const out: ExportTable[] = [];
  for (const wbFile of await loadXtbWorkbook(data, fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(wbFile.data) as unknown as ArrayBuffer);
    const inner = wbFile.name.split(/[\\/]/).pop() ?? wbFile.name;
    const m = /^([A-Z]{3})_([\w-]+?)_/.exec(inner);
    const warnings: string[] = [];
    const cashWs = wb.worksheets.find((w) => /cash operation/i.test(w.name));
    if (!cashWs) throw new Error(`${inner}: chybí list "Cash Operations"`);
    const rows = sheetRows(cashWs);
    const hdr = headerIndex(rows, ['type', 'time', 'amount']);
    if (!hdr) throw new Error(`${inner}: nerozpoznaná hlavička listu Cash Operations`);
    const preamble = rows.slice(0, hdr.idx);
    let account = m?.[2];
    if (!account) {
      const accRow = preamble.find((r) => /account/i.test(cellText(r[0])));
      account = accRow ? cellText(accRow[1]) : undefined;
    }
    account = safeAccount(account);
    const currency = m?.[1] ?? 'CZK';
    if (!m) warnings.push(`Měna účtu XTB nebyla v názvu souboru nalezena – použije se ${currency}.`);

    let declaredRange: DateRange | undefined;
    const from = findLabelled(preamble, /date from/i);
    const to = findLabelled(preamble, /date to/i);
    if (from && to) declaredRange = { from: isoDateUtc(from), to: isoDateUtc(to) };
    else {
      const fm = /_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/.exec(inner) ?? /_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/.exec(fileName);
      if (fm && isIsoDate(fm[1]) && isIsoDate(fm[2])) declaredRange = { from: fm[1], to: fm[2] };
    }

    const iType = hdr.cols.get('type') ?? -1;
    const iTime = hdr.cols.get('time') ?? -1;
    const records: ExportRecord[] = [];
    let noTime = 0;
    for (const r of rows.slice(hdr.idx + 1)) {
      const type = cellText(r[iType]);
      if (!type || /^total$/i.test(type)) continue;
      const when = cellDate(r[iTime]);
      if (!when) {
        noTime++;
        continue;
      }
      const t = xtbTime(when);
      if (!plausibleYear(t)) {
        noTime++;
        continue;
      }
      const stored = Array.from({ length: r.length }, (_, j) => storedCell(r[j]));
      stored[iTime] = t;
      records.push({ date: t.slice(0, 10), sortKey: t, key: stored.map((c) => (c === null || c === undefined ? '' : String(c).trim())).join(FIELD_SEP), rows: [stored] });
    }
    if (noTime) warnings.push(`${noTime} řádků bez platného času operace bylo vynecháno.`);

    let openPositions: ExportTable['openPositions'];
    const openWs = wb.worksheets.find((w) => /open position/i.test(w.name));
    if (openWs) {
      const orows = sheetRows(openWs);
      const asOf = findLabelled(orows.slice(0, 6), /as of|generated/i);
      openPositions = { asOf: asOf ? xtbTime(asOf) : declaredRange ? `${declaredRange.to} 23:59:59` : '', rows: orows.map((r) => Array.from({ length: r.length }, (_, j) => storedCell(r[j]))) };
    }

    out.push({
      unit: `xtb/${account}`,
      kind: 'XTB',
      label: `XTB – účet ${account} (${currency})`,
      account,
      currency,
      header: [...preamble.filter((r) => !r.some((c) => /date (from|to)/i.test(cellText(c)))).map((r) => r.map(storedCell)), rows[hdr.idx].map(storedCell)],
      records,
      declaredRange,
      openPositions,
      warnings,
    });
  }
  return out;
}

async function sheetBook(name: string, rows: readonly unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  for (const r of rows) ws.addRow(r.map((c) => (c === undefined ? null : c)) as ExcelJS.CellValue[]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function writeXtbCashBook(header: unknown[][], records: readonly ExportRecord[]): Promise<Buffer> {
  return sheetBook('Cash Operations', [...header, ...records.flatMap((r) => r.rows)]);
}

export function writeXtbOpenPositionsBook(rows: unknown[][]): Promise<Buffer> {
  return sheetBook('Open Positions', rows);
}

export function xtbYearFileName(currency: string, account: string, year: number): string {
  return `${currency}_${account}_${year}.xlsx`;
}

export function xtbOpenPositionsFileName(currency: string, account: string): string {
  return `${currency}_${account}_open-positions.xlsx`;
}
