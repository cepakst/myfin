import { detectBankKind } from '../accounts/bankTables.js';
import { looksLikePdfStatements } from '../accounts/rbPdfTables.js';
import { sortRecords } from '../exportStore.js';
import { headerSignature, readDegiroTable, writeCsv, type BankTableKind, type ExportTable } from '../exportTables.js';
import { emptyLedger, type Ledger } from '../types.js';
import { parseDegiroAccount, parseDegiroTransactions } from './degiro.js';
import { loadXtbWorkbook, parseXtbXlsx } from './xtb.js';

export interface InputFile {
  name: string;
  data: Uint8Array;
}

export type FileKind = 'DEGIRO_TX' | 'DEGIRO_ACCOUNT' | 'XTB' | BankTableKind | 'UNKNOWN';
type Kind = FileKind;

export function detectFileKind(name: string, data: Uint8Array): Kind {
  const lower = name.toLowerCase();
  // bank statements (accounts module) are CSV files; they never reach the investment ledger
  const bank = detectBankKind(name, data);
  if (bank) return bank;
  // other files of the bank store (statement summaries): never an investment export
  if (/^\uFEFF?"?#myfin-bank"?,/.test(new TextDecoder('utf-8').decode(data.subarray(0, 32)))) return 'BANK_RB_PDF';
  // RB PDF statements, also as the zip the internet banking downloads (XTB zips hold workbooks)
  if (looksLikePdfStatements(name, data)) return 'BANK_RB_PDF';
  if (lower.endsWith('.zip') || lower.endsWith('.xlsx')) return 'XTB';
  if (lower.endsWith('.csv')) {
    const head = new TextDecoder('utf-8').decode(data.slice(0, 600)).split(/\r?\n/)[0] ?? '';
    if (/Venue|Reference exchange|Order ID/i.test(head) && /Quantity|Počet/i.test(head)) return 'DEGIRO_TX';
    if (/Description|Popis|Omschrijving/i.test(head) && /Balance|Zůstatek|Saldo/i.test(head)) return 'DEGIRO_ACCOUNT';
  }
  return 'UNKNOWN';
}

/**
 * Degiro files of one kind (e.g. one per year) are joined into a single table before parsing, so that
 * corporate actions and dividend corrections spanning two files are still grouped together.
 */
function combineDegiro(files: InputFile[], kind: 'DEGIRO_TX' | 'DEGIRO_ACCOUNT', ledger: Ledger): { name: string; text: string }[] {
  const groups = new Map<string, { names: string[]; texts: string[]; tables: ExportTable[] }>();
  for (const f of files) {
    try {
      const text = new TextDecoder('utf-8').decode(f.data);
      const t = readDegiroTable(text, kind);
      for (const w of t.warnings) ledger.warnings.push({ source: f.name, message: w });
      const sig = headerSignature(t);
      const g = groups.get(sig) ?? { names: [], texts: [], tables: [] };
      g.names.push(f.name);
      g.texts.push(text);
      g.tables.push(t);
      groups.set(sig, g);
    } catch (e) {
      ledger.warnings.push({ source: f.name, message: `Chyba při načítání: ${(e as Error).message}` });
    }
  }
  return [...groups.values()].map((g) => ({
    name: g.names.length === 1 ? g.names[0] : `${g.names[0]} (+ ${g.names.length - 1} dalších)`,
    text: g.tables.length === 1 ? g.texts[0] : writeCsv(g.tables[0].header, sortRecords(g.tables.flatMap((t) => t.records))),
  }));
}

/** Investment ledger. Bank statements among `files` are skipped (they belong to the accounts module). */
export async function buildLedger(files: InputFile[]): Promise<Ledger> {
  const ledger = emptyLedger();
  const kinds = files.map((f) => ({ f, kind: detectFileKind(f.name, f.data) }));
  const of = (k: Kind) => kinds.filter((x) => x.kind === k).map((x) => x.f);
  for (const c of combineDegiro(of('DEGIRO_TX'), 'DEGIRO_TX', ledger)) {
    try {
      parseDegiroTransactions(c.text, ledger, c.name);
    } catch (e) {
      ledger.warnings.push({ source: c.name, message: `Chyba při načítání: ${(e as Error).message}` });
    }
  }
  // Account after Transactions: transaction taxes are attached to the parsed trades
  for (const c of combineDegiro(of('DEGIRO_ACCOUNT'), 'DEGIRO_ACCOUNT', ledger)) {
    try {
      parseDegiroAccount(c.text, ledger, c.name);
    } catch (e) {
      ledger.warnings.push({ source: c.name, message: `Chyba při načítání: ${(e as Error).message}` });
    }
  }
  for (const f of of('XTB')) {
    try {
      for (const wb of await loadXtbWorkbook(f.data, f.name)) await parseXtbXlsx(wb.data, ledger, `${f.name}/${wb.name}`);
    } catch (e) {
      ledger.warnings.push({ source: f.name, message: `Chyba při načítání: ${(e as Error).message}` });
    }
  }
  for (const f of of('UNKNOWN')) ledger.warnings.push({ source: f.name, message: 'Neznámý formát souboru – přeskočeno.' });
  ledger.trades.sort((a, b) => (a.dateTime === b.dateTime ? b.quantity - a.quantity : a.dateTime < b.dateTime ? -1 : 1));
  ledger.actions.sort((a, b) => (a.dateTime < b.dateTime ? -1 : a.dateTime > b.dateTime ? 1 : 0));
  ledger.cash.sort((a, b) => (a.dateTime < b.dateTime ? -1 : a.dateTime > b.dateTime ? 1 : 0));
  return ledger;
}
