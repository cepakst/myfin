/**
 * Bank statement exports (Fio, KB, Raiffeisenbank CSV) -> row-preserving tables for the store, and
 * stored tables -> normalised bank transactions. No file system access.
 *
 * The store keeps the bank's own columns, re-encoded as UTF-8 comma separated CSV with a marker row
 * in front (`#myfin-bank,1,<BANK>,<account number>,<currency>`), so a stored year file is
 * self-describing and the rows can be compared with a freshly read export.
 */
import { parse } from 'csv-parse/sync';
import type { DateRange, ExportRecord } from '../exportStore.js';
import { FIELD_SEP, plausibleYear, safeAccount, type BankTableKind, type ExportTable } from '../exportTables.js';
import { addDays, parseNum } from '../util.js';
import { BANK_CODE, type BalancePoint, type Bank, type BankAccountData, type BankTx } from './types.js';

export const BANK_MARKER = '#myfin-bank';

export const KIND_BANK: Record<BankTableKind, Bank> = { BANK_FIO: 'FIO', BANK_KB: 'KB', BANK_RB: 'RB' };
export const BANK_KIND: Record<Bank, BankTableKind> = { FIO: 'BANK_FIO', KB: 'BANK_KB', RB: 'BANK_RB' };
const BANK_LABEL: Record<Bank, string> = { FIO: 'Fio', KB: 'KB', RB: 'Raiffeisenbank' };

export function isBankKind(kind: string): kind is BankTableKind {
  return kind === 'BANK_FIO' || kind === 'BANK_KB' || kind === 'BANK_RB';
}

/** UTF-8 when the bytes are valid UTF-8, otherwise windows-1250 (KB exports). */
export function decodeBankText(data: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder('windows-1250').decode(data);
  }
  return text.replace(/^﻿/, '');
}

/** Detects a bank export (or a stored bank year file) from the first bytes of the file. */
export function detectBankKind(name: string, data: Uint8Array): BankTableKind | null {
  if (!/\.csv$/i.test(name)) return null;
  // cut the sample at a line end, so a split multi-byte character does not switch the decoding
  // (callers may pass a 4000-byte prefix of a longer file, so trim whenever the sample is full)
  let sample = data.subarray(0, 4000);
  if (sample.length === 4000) {
    const nl = sample.lastIndexOf(0x0a);
    if (nl > 0) sample = sample.subarray(0, nl);
  }
  const head = decodeBankText(sample);
  const first = head.split(/\r?\n/)[0] ?? '';
  const stored = new RegExp(`^"?${BANK_MARKER}"?,"?1"?,"?(FIO|KB|RB)"?,`).exec(first);
  if (stored) return BANK_KIND[stored[1] as Bank];
  if (/^"?Výpis č\.\s*\d+\/\d{4} z účtu/.test(first) || /"ID operace";"Datum";"Objem";"Měna"/.test(head)) return 'BANK_FIO';
  if (/^KB\+?,? ?vypis v csv/i.test(first) || /^Datum zauctovani;Datum provedeni;Protistrana;/m.test(head)) return 'BANK_KB';
  if (/Datum provedení/.test(first) && /Zaúčtovaná částka/.test(first) && /Id transakce/.test(first)) return 'BANK_RB';
  return null;
}

/** "D.M.YYYY" or "DD.MM.YYYY" (optionally followed by a time) -> ISO date, or null */
export function czDateToIso(s: string | undefined): string | null {
  const m = /^\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(s ?? '');
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

function parseRows(text: string, delimiter: string): string[][] {
  return parse(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: false, bom: true }) as string[][];
}

/** Lower case without diacritics – KB writes its column names without them. */
function norm(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function col(header: string[], name: string, nth = 0): number {
  const n = norm(name);
  let seen = 0;
  for (let i = 0; i < header.length; i++) {
    if (norm(header[i]) === n) {
      if (seen === nth) return i;
      seen++;
    }
  }
  return -1;
}

/** Column holding the booking date of each bank's export */
const DATE_COL: Record<Bank, string> = { FIO: 'Datum', KB: 'Datum zauctovani', RB: 'Datum zaúčtování' };
const ID_COL: Record<Bank, string> = { FIO: 'ID operace', KB: 'Identifikace transakce', RB: 'Id transakce' };

interface AccountInfo {
  number: string;
  currency: string;
}

function splitAccount(raw: string, bank: Bank): string {
  return raw.trim().replace(new RegExp(`/${BANK_CODE[bank]}$`), '').replace(/\s/g, '');
}

function makeTable(
  bank: Bank,
  acc: AccountInfo,
  header: string[],
  dataRows: string[][],
  extra: { declaredRange?: DateRange; balances?: BalancePoint[]; warnings?: string[] },
): ExportTable {
  const iDate = col(header, DATE_COL[bank]);
  const iId = col(header, ID_COL[bank]);
  if (iDate < 0) throw new Error(`Nerozpoznaná hlavička výpisu ${BANK_LABEL[bank]} (chybí sloupec ${DATE_COL[bank]})`);
  const width = header.length;
  const records: ExportRecord[] = [];
  let skipped = 0;
  for (const raw of dataRows) {
    if (raw.every((c) => !(c ?? '').trim())) continue;
    const r = Array.from({ length: width }, (_, i) => (raw[i] ?? '').trim());
    const date = czDateToIso(r[iDate]);
    if (!date || !plausibleYear(date)) {
      skipped++;
      continue;
    }
    records.push({ date, sortKey: `${date}|${iId >= 0 ? r[iId] : ''}`, key: r.join(FIELD_SEP), rows: [r] });
  }
  // the number becomes a folder name: anything else than a Czech account number is refused, so two
  // accounts can never end up in the same folder (safeAccount falls back to a shared name)
  if (!/^(\d{1,6}-)?\d{2,10}$/.test(acc.number)) throw new Error(`Neplatné číslo účtu ve výpisu ${BANK_LABEL[bank]}`);
  const account = safeAccount(acc.number);
  const warnings = [...(extra.warnings ?? [])];
  if (skipped) warnings.push(`${skipped} řádků bez platného data zaúčtování bylo vynecháno.`);
  return {
    unit: `banks/${bank.toLowerCase()}/${account}`,
    kind: BANK_KIND[bank],
    label: `${BANK_LABEL[bank]} – účet ${acc.number}/${BANK_CODE[bank]} (${acc.currency})`,
    account,
    currency: acc.currency,
    header: [[BANK_MARKER, '1', bank, acc.number, acc.currency], header.map((h) => h.trim())],
    records,
    declaredRange: extra.declaredRange,
    balances: extra.balances,
    warnings,
  };
}

function readFio(text: string): ExportTable[] {
  const rows = parseRows(text, ';');
  const hi = rows.findIndex((r) => norm(r[0]) === 'id operace');
  if (hi < 0) throw new Error('Nerozpoznaný výpis Fio (chybí hlavička „ID operace“)');
  const meta = rows.slice(0, hi).map((r) => r.join(';'));
  const find = (re: RegExp) => meta.map((l) => re.exec(l)).find((m) => m);
  const accM = find(/z účtu\s*"*([\d-]+)\/(\d{4})/);
  if (!accM) throw new Error('Výpis Fio neobsahuje číslo účtu');
  const per = find(/Období:\s*(\d{1,2}\.\d{1,2}\.\d{4})\s*-\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
  const amount = '(-?[\\d\\s\\u00a0.,]+?)\\s*([A-Z]{3})';
  const open = find(new RegExp(`Počáteční stav účtu k (\\d{1,2}\\.\\d{1,2}\\.\\d{4}):\\s*${amount}`));
  const close = find(new RegExp(`Koncový stav účtu k (\\d{1,2}\\.\\d{1,2}\\.\\d{4}):\\s*${amount}`));
  const header = rows[hi];
  const iCur = col(header, 'Měna');
  const dataRows = rows.slice(hi + 1);
  const currency = close?.[3] ?? open?.[3] ?? dataRows.find((r) => r[iCur])?.[iCur]?.trim() ?? 'CZK';
  const from = czDateToIso(per?.[1]);
  const to = czDateToIso(per?.[2]);
  const declaredRange = from && to && from <= to ? { from, to } : undefined;
  const balances: BalancePoint[] = [];
  const openDate = czDateToIso(open?.[1]);
  const openBal = parseNum(open?.[2]);
  // the opening balance is the balance at the start of the day = end of the previous day
  if (openDate && Number.isFinite(openBal)) balances.push({ date: addDays(openDate, -1), balance: openBal });
  const closeDate = czDateToIso(close?.[1]);
  const closeBal = parseNum(close?.[2]);
  if (closeDate && Number.isFinite(closeBal)) balances.push({ date: closeDate, balance: closeBal });
  if (accM[2] !== BANK_CODE.FIO) throw new Error(`Výpis Fio s neočekávaným kódem banky ${accM[2]}`);
  return [makeTable('FIO', { number: accM[1], currency }, header, dataRows, { declaredRange, balances })];
}

function readKb(text: string): ExportTable[] {
  const rows = parseRows(text, ';');
  const hi = rows.findIndex((r) => norm(r[0]) === 'datum zauctovani');
  if (hi < 0) throw new Error('Nerozpoznaný výpis KB (chybí hlavička „Datum zauctovani“)');
  const meta = rows.slice(0, hi);
  const row = (label: string) => meta.find((r) => norm(r[0]) === norm(label));
  const number = row('Cislo uctu')?.[1]?.trim();
  if (!number) throw new Error('Výpis KB neobsahuje číslo účtu');
  const currency = (row('Mena uctu / Hlavni mena uctu')?.[1] ?? row('Mena uctu')?.[1] ?? 'CZK').trim() || 'CZK';
  const from = czDateToIso(row('Vypis od')?.[1]);
  const to = czDateToIso(row('Vypis do')?.[1]);
  const declaredRange = from && to && from <= to ? { from, to } : undefined;
  // balances are listed per currency in the columns of the "Mena" row
  const curRow = row('Mena');
  const ci = curRow ? Math.max(1, curRow.findIndex((c, i) => i > 0 && c.trim() === currency)) : 1;
  const balances: BalancePoint[] = [];
  const openBal = parseNum(row('Pocatecni zustatek')?.[ci]);
  const closeBal = parseNum(row('Konecny zustatek')?.[ci]);
  if (from && Number.isFinite(openBal)) balances.push({ date: addDays(from, -1), balance: openBal });
  if (to && Number.isFinite(closeBal)) balances.push({ date: to, balance: closeBal });
  // every line is padded with empty fields to the same width; the header defines the columns
  let header = rows[hi];
  while (header.length && !header[header.length - 1].trim()) header = header.slice(0, -1);
  return [makeTable('KB', { number: splitAccount(number, 'KB'), currency }, header, rows.slice(hi + 1), { declaredRange, balances })];
}

function readRb(text: string): ExportTable[] {
  const rows = parseRows(text, ';');
  const header = rows[0] ?? [];
  const iAcc = col(header, 'Číslo účtu');
  const iCur = col(header, 'Měna účtu');
  if (iAcc < 0) throw new Error('Nerozpoznaný výpis Raiffeisenbank (chybí sloupec „Číslo účtu“)');
  // one export is one account, but split defensively when it contains more
  const groups = new Map<string, string[][]>();
  for (const r of rows.slice(1)) {
    if (r.every((c) => !(c ?? '').trim())) continue;
    const acc = splitAccount(r[iAcc] ?? '', 'RB');
    if (!acc) continue;
    const g = groups.get(acc);
    if (g) g.push(r);
    else groups.set(acc, [r]);
  }
  return [...groups].map(([number, rs]) => makeTable('RB', { number, currency: (iCur >= 0 ? rs.find((r) => r[iCur]?.trim())?.[iCur]?.trim() : '') || 'CZK' }, header, rs, {}));
}

function readStored(text: string, kind: BankTableKind): ExportTable[] {
  const rows = parse(text, { relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
  const marker = rows[0] ?? [];
  if (marker[0] !== BANK_MARKER || marker[2] !== KIND_BANK[kind]) throw new Error('Nerozpoznaný uložený soubor banky');
  const t = makeTable(KIND_BANK[kind], { number: marker[3] ?? '', currency: marker[4] || 'CZK' }, rows[1] ?? [], rows.slice(2), {});
  return [t];
}

/** Bank export or stored bank year file -> one table per account. */
export function readBankTables(fileName: string, data: Uint8Array, kind?: BankTableKind | null): ExportTable[] {
  const k = kind ?? detectBankKind(fileName, data);
  if (!k) throw new Error(`${fileName}: neznámý formát výpisu z účtu`);
  const text = decodeBankText(data);
  if (text.startsWith(BANK_MARKER) || text.startsWith(`"${BANK_MARKER}"`)) return readStored(text, k);
  if (k === 'BANK_FIO') return readFio(text);
  if (k === 'BANK_KB') return readKb(text);
  return readRb(text);
}

export interface BalancesMeta {
  bank: Bank;
  number: string;
  currency: string;
}

const safeField = (v: string) => v.replace(/[",\r\n]/g, '');

/** Stored balances file: the marker row, then `date,balance` rows (balance at the end of the day). */
export function writeBalancesCsv(meta: BalancesMeta, points: readonly BalancePoint[]): string {
  const lines = [
    [BANK_MARKER, '1', meta.bank, safeField(meta.number), safeField(meta.currency)].join(','),
    'date,balance',
    ...[...points].sort((a, b) => (a.date < b.date ? -1 : 1)).map((p) => `${p.date},${p.balance}`),
  ];
  return lines.join('\n') + '\n';
}

export function readBalancesCsv(text: string): { meta: BalancesMeta | null; points: BalancePoint[] } {
  const rows = parse(text, { relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
  const m = rows[0] ?? [];
  const meta = m[0] === BANK_MARKER && (m[2] === 'FIO' || m[2] === 'KB' || m[2] === 'RB') ? { bank: m[2] as Bank, number: m[3] ?? '', currency: m[4] || 'CZK' } : null;
  const out: BalancePoint[] = [];
  for (const r of rows.slice(meta ? 2 : 1)) {
    const balance = Number(r[1]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r[0] ?? '') && Number.isFinite(balance)) out.push({ date: r[0], balance });
  }
  return { meta, points: out };
}

/** Stored balances file (`banks/<bank>/<account>/balances.csv`)? */
export function isBalancesFile(name: string): boolean {
  return /(^|[\\/])balances\.csv$/i.test(name);
}

export { mergeBalances } from './balances.js';

// --- normalised transactions ---

function opt(s: string | undefined): string | undefined {
  const v = (s ?? '').trim();
  return v ? v : undefined;
}

/** Payment symbols: KB writes "0" for an empty symbol */
function sym(s: string | undefined): string | undefined {
  const v = (s ?? '').trim().replace(/^0+/, '');
  return v ? v : undefined;
}

function num(s: string | undefined): number | undefined {
  const n = parseNum(s ?? '');
  return Number.isFinite(n) ? n : undefined;
}

function joinText(...parts: (string | undefined)[]): string | undefined {
  const uniq = [...new Set(parts.map((p) => (p ?? '').trim()).filter(Boolean))];
  return uniq.length ? uniq.join(' · ') : undefined;
}

/** FNV-1a – a short stable id for rows without a bank transaction id */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** "Nákup: ALBERT 1234, Praha, CZ, dne 1.2.2025, částka 100.00 CZK" -> "ALBERT 1234" */
function fioMerchant(text: string | undefined): string | undefined {
  const m = /^Nákup:\s*([^,]+)/i.exec(text ?? '');
  return m ? m[1].trim() : undefined;
}

/**
 * Normalised transactions of a stored (or freshly read) bank table. Rows are taken in file order;
 * the key is stable across re-imports (bank transaction id, or the row content when there is none).
 */
export function bankTxsFromTable(t: ExportTable): { account: BankAccountData; txs: BankTx[] } {
  if (!isBankKind(t.kind)) throw new Error('Not a bank table');
  const bank = KIND_BANK[t.kind];
  const marker = t.header[0] as string[];
  const header = (t.header[t.header.length - 1] as string[]).map(String);
  const number = String(marker[3] ?? t.account ?? '');
  const accountId = `${number}/${BANK_CODE[bank]}`;
  const c = (name: string, nth = 0) => col(header, name, nth);
  const at = (r: string[], i: number) => (i >= 0 ? r[i] : undefined);
  const txs: BankTx[] = [];
  const seenKeys = new Map<string, number>();
  let name: string | undefined;

  const idx =
    bank === 'FIO'
      ? {
          id: c('ID operace'),
          date: c('Datum'),
          amount: c('Objem'),
          cur: c('Měna'),
          cp: c('Protiúčet'),
          cpBank: c('Kód banky'),
          cpName: c('Název protiúčtu'),
          ks: c('KS'),
          vs: c('VS'),
          ss: c('SS'),
          ident: c('Poznámka', 0),
          message: c('Zpráva pro příjemce'),
          type: c('Typ'),
          detail: c('Upřesnění'),
          note: c('Poznámka', 1),
        }
      : null;

  for (const rec of t.records) {
    const r = (rec.rows[0] as unknown[]).map((v) => (v === null || v === undefined ? '' : String(v)));
    let tx: Omit<BankTx, 'key'>;
    if (bank === 'FIO' && idx) {
      const cp = opt(at(r, idx.cp));
      const cpBank = opt(at(r, idx.cpBank));
      const ident = opt(at(r, idx.ident));
      const detail = opt(at(r, idx.detail));
      const orig = /^(-?[\d\s.,]+)\s+([A-Z]{3})$/.exec(detail ?? '');
      tx = {
        bank,
        accountId,
        date: rec.date,
        amount: num(at(r, idx.amount)) ?? 0,
        currency: opt(at(r, idx.cur)) ?? t.currency ?? 'CZK',
        origAmount: orig ? num(orig[1]) : undefined,
        origCurrency: orig ? orig[2] : undefined,
        cpAccount: cp ? (cpBank ? `${cp}/${cpBank}` : cp) : undefined,
        cpName: opt(at(r, idx.cpName)),
        merchant: fioMerchant(ident),
        vs: sym(at(r, idx.vs)),
        ks: sym(at(r, idx.ks)),
        ss: sym(at(r, idx.ss)),
        message: joinText(at(r, idx.message), ident),
        note: opt(at(r, idx.note)),
        bankType: opt(at(r, idx.type)) ?? '',
        bankTxId: opt(at(r, idx.id)),
      };
    } else if (bank === 'KB') {
      const valueDate = czDateToIso(at(r, c('Datum provedeni'))) ?? undefined;
      tx = {
        bank,
        accountId,
        date: rec.date,
        valueDate: valueDate && valueDate !== rec.date ? valueDate : undefined,
        amount: num(at(r, c('Castka'))) ?? 0,
        currency: opt(at(r, c('Mena'))) ?? t.currency ?? 'CZK',
        origAmount: num(at(r, c('Originalni castka'))),
        origCurrency: opt(at(r, c('Originalni mena'))),
        cpAccount: opt(at(r, c('Protistrana'))),
        cpName: opt(at(r, c('Nazev protiuctu'))),
        vs: sym(at(r, c('VS'))),
        ks: sym(at(r, c('KS'))),
        ss: sym(at(r, c('SS'))),
        message: opt(at(r, c('Zprava pro prijemce'))),
        note: opt(at(r, c('Popis pro me'))),
        bankType: opt(at(r, c('Typ transakce'))) ?? '',
        bankTxId: opt(at(r, c('Identifikace transakce'))),
      };
    } else {
      const valueDate = czDateToIso(at(r, c('Datum provedení'))) ?? undefined;
      name ??= opt(at(r, c('Název účtu')));
      tx = {
        bank,
        accountId,
        date: rec.date,
        valueDate: valueDate && valueDate !== rec.date ? valueDate : undefined,
        amount: num(at(r, c('Zaúčtovaná částka'))) ?? 0,
        currency: opt(at(r, c('Měna účtu'))) ?? t.currency ?? 'CZK',
        origAmount: num(at(r, c('Původní částka'))),
        origCurrency: opt(at(r, c('Původní měna'))),
        cpAccount: opt(at(r, c('Číslo protiúčtu'))),
        cpName: opt(at(r, c('Název protiúčtu'))),
        merchant: opt(at(r, c('Název obchodníka'))),
        city: opt(at(r, c('Město'))),
        vs: sym(at(r, c('VS'))),
        ks: sym(at(r, c('KS'))),
        ss: sym(at(r, c('SS'))),
        message: opt(at(r, c('Zpráva'))),
        note: joinText(at(r, c('Poznámka')), at(r, c('Vlastní poznámka'))),
        bankType: opt(at(r, c('Typ transakce'))) ?? '',
        bankCategory: opt(at(r, c('Kategorie transakce'))),
        bankTxId: opt(at(r, c('Id transakce'))),
      };
    }
    const base = `${bank}:${accountId}:${tx.bankTxId ?? `h${hash(rec.key)}`}`;
    const n = seenKeys.get(base) ?? 0;
    seenKeys.set(base, n + 1);
    txs.push({ key: n ? `${base}#${n}` : base, ...tx });
  }
  return {
    account: { id: accountId, bank, number, name, currency: t.currency ?? 'CZK', balancePoints: t.balances ? [...t.balances] : [] },
    txs,
  };
}
