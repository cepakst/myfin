/**
 * Raiffeisenbank PDF statements ("Výpis z běžného/spořicího účtu") -> statement summary and movements.
 * Works on positioned text items (see pdfText.ts), so it stays pure and testable without PDF files.
 *
 * Layout (both the current and the older template): a header block with the account, period and
 * balances, then a table where every movement takes three rows:
 *   Datum          | Kategorie transakce | Typ transakce | VS | Poplatek | Částka
 *   Valuta         | Číslo protiúčtu     | Zpráva        | KS |          | Původní částka
 *   Kód transakce  | Název protiúčtu     | Poznámka      | SS |          | Kurz
 * Texts may wrap to further lines; those belong to the row above them. Card payments carry the
 * masked card number ("PK: …", never stored) and "merchant; city; country" in the note.
 */
import { BANK_CODE, type StatementSummary } from './types.js';

export interface PdfItem {
  x: number;
  y: number;
  /** width of the text run */
  w: number;
  s: string;
}

export type PdfPage = PdfItem[];

export interface RbPdfTx {
  /** booking date (ISO) */
  date: string;
  valueDate?: string;
  /** "Kód transakce" – the same value as "Id transakce" of the CSV export */
  code?: string;
  category?: string;
  cpAccount?: string;
  cpName?: string;
  type?: string;
  message?: string;
  note?: string;
  vs?: string;
  ks?: string;
  ss?: string;
  fee?: number;
  amount: number;
  currency: string;
  origAmount?: number;
  origCurrency?: string;
  rate?: number;
  merchant?: string;
  city?: string;
  country?: string;
}

export interface RbStatement extends StatementSummary {
  /** account number without the bank code (`[prefix-]number`) */
  number: string;
  currency: string;
  txs: RbPdfTx[];
  warnings: string[];
}

/** The PDF is not an RB account statement (another document, encrypted, damaged). */
export class NotRbStatementError extends Error {}

/** The PDF is an RB statement, but its layout was not understood (retried after an app update). */
export class RbStatementFormatError extends Error {}

interface Row {
  y: number;
  items: PdfItem[];
}

/** Items whose baselines differ by up to this many points are one visual row (the older template
 * offsets some cells by a point or two). Wrapped lines are about 9 points apart. */
const ROW_TOLERANCE = 2.5;

function rowsOf(page: PdfPage): Row[] {
  const items = page.filter((i) => i.s.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Row[] = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= ROW_TOLERANCE) last.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

const text = (r: Row) => r.items.map((i) => i.s.trim()).join(' ');
const clean = (s: string) => s.replace(/[\s ]+/g, ' ').trim();

const DATE_RE = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/;
const MONEY_RE = /^(-?\d{1,3}(?:[  ]\d{3})*\.\d{2})(?:\s+([A-Z]{3}))?$/;

function isoDate(s: string): string | null {
  const m = DATE_RE.exec(clean(s));
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

function money(s: string): { value: number; currency?: string } | null {
  const m = MONEY_RE.exec(clean(s));
  if (!m) return null;
  return { value: Number(m[1].replace(/[  ]/g, '')), currency: m[2] };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Value of a labelled header field ("Počáteční zůstatek: 1 234.56"). */
function labelled(rows: Row[], label: RegExp): number | null {
  for (const r of rows) {
    const i = r.items.findIndex((it) => label.test(clean(it.s)));
    if (i < 0) continue;
    // the value follows the label; the owner's address is printed further right on the same lines
    for (const it of r.items.slice(i + 1)) {
      const m = money(it.s);
      if (m) return m.value;
    }
  }
  return null;
}

type Col = 'c0' | 'c1' | 'c2' | 'c3' | 'fee' | 'amt';

interface Columns {
  /** left edges of the text columns */
  x: Record<'c0' | 'c1' | 'c2' | 'c3' | 'fee' | 'amt', number>;
  feeRight: number;
}

/** Column positions from the table header row ("Datum | Kategorie transakce | Typ transakce | VS | Poplatek | Částka"). */
function tableColumns(r: Row): Columns | null {
  const find = (re: RegExp) => r.items.find((i) => re.test(clean(i.s)));
  const d = find(/^Datum$/);
  const k = find(/^Kategorie transakce$/);
  const t = find(/^Typ transakce$/);
  const vs = find(/^VS$/);
  const fee = find(/^Poplatek$/);
  const amt = find(/^Částka$/);
  if (!d || !k || !t || !vs || !fee || !amt) return null;
  return { x: { c0: d.x, c1: k.x, c2: t.x, c3: vs.x, fee: fee.x, amt: amt.x }, feeRight: fee.x + fee.w };
}

function columnOf(it: PdfItem, c: Columns): Col {
  const x = it.x + 3;
  if (x >= c.x.fee) {
    // amounts are right-aligned: a fee ends under the "Poplatek" header, amounts end further right
    return it.x + it.w <= c.feeRight + 15 ? 'fee' : 'amt';
  }
  if (x >= c.x.c3) return 'c3';
  if (x >= c.x.c2) return 'c2';
  if (x >= c.x.c1) return 'c1';
  return 'c0';
}

interface Draft {
  /** texts per row slot (0 = first row, 1 = second, 2 = third) and column */
  cells: Record<Col, string[]>[];
  slot: number;
  hasValue: boolean;
  hasCode: boolean;
}

const emptyCells = (): Record<Col, string[]> => ({ c0: [], c1: [], c2: [], c3: [], fee: [], amt: [] });

function joined(parts: string[] | undefined, sep = ' '): string | undefined {
  const v = clean((parts ?? []).join(sep));
  return v ? v : undefined;
}

function symbol(s: string | undefined): string | undefined {
  const v = (s ?? '').replace(/\s/g, '').replace(/^0+/, '');
  return v ? v : undefined;
}

function finishTx(d: Draft, currency: string, warnings: string[]): RbPdfTx | null {
  const [r1, r2, r3] = [d.cells[0], d.cells[1] ?? emptyCells(), d.cells[2] ?? emptyCells()];
  const date = isoDate(r1.c0[0] ?? '');
  const amt = money(joined(r1.amt) ?? '');
  if (!date || !amt) {
    warnings.push('Řádek výpisu se nepodařilo přečíst a byl vynechán.');
    return null;
  }
  const valueDate = isoDate(r2.c0[0] ?? '') ?? undefined;
  const code = r3.c0.find((s) => /^\d{4,}$/.test(clean(s)));
  const orig = money(joined(r2.amt) ?? '');
  const rate = Number(clean(joined(r3.amt) ?? '').replace(/\s/g, ''));
  // the note: masked card number dropped, "merchant; city; country" split out
  let merchant: string | undefined;
  let city: string | undefined;
  let country: string | undefined;
  const noteParts: string[] = [];
  for (const p of r3.c2) {
    const s = clean(p);
    if (/^PK:/.test(s)) continue;
    const m = s.length <= 300 ? /^([^;]+);\s*([^;]*);\s*([A-Z]{3})$/.exec(s) : null;
    if (m && merchant === undefined) {
      merchant = m[1].trim();
      city = m[2].trim() || undefined;
      country = m[3];
      continue;
    }
    noteParts.push(s);
  }
  const fee = money(joined(r1.fee) ?? '');
  // card payments name the card holder (the user) as the counterparty: not stored
  const card = r3.c2.some((s) => /^PK:/.test(clean(s)));
  return {
    date,
    valueDate: valueDate && valueDate !== date ? valueDate : undefined,
    code: code ? clean(code) : undefined,
    category: joined(r1.c1),
    cpAccount: joined(r2.c1, '')?.replace(/\s/g, ''),
    cpName: card ? undefined : joined(r3.c1),
    type: joined(r1.c2),
    message: joined(r2.c2),
    note: joined(noteParts),
    vs: symbol(joined(r1.c3)),
    ks: symbol(joined(r2.c3)),
    ss: symbol(joined(r3.c3)),
    fee: fee && fee.value !== 0 ? fee.value : undefined,
    amount: amt.value,
    currency: amt.currency ?? currency,
    origAmount: orig && orig.currency && orig.currency !== (amt.currency ?? currency) ? orig.value : undefined,
    origCurrency: orig && orig.currency && orig.currency !== (amt.currency ?? currency) ? orig.currency : undefined,
    rate: Number.isFinite(rate) && rate > 0 && orig?.currency ? rate : undefined,
    merchant,
    city,
    country,
  };
}

/**
 * Reads one RB statement. Throws NotRbStatementError for other PDFs. The movements are checked
 * against the stated balances; a difference is reported as a warning.
 */
export function parseRbStatement(pages: readonly PdfPage[]): RbStatement {
  const pageRows = pages.map(rowsOf);
  const head = pageRows[0] ?? [];
  const all = pageRows.flat().map(text);
  const joinedText = all.join('\n');
  if (!/Raiffeisenbank/i.test(joinedText) || !/Výpis z/.test(joinedText)) throw new NotRbStatementError('PDF není výpis z účtu Raiffeisenbank.');

  const accLine = all.find((l) => /Číslo účtu:/.test(l)) ?? '';
  const acc = /Číslo účtu:\s*((?:\d{1,6}-)?\d{2,10})\s*\/\s*(\d{4})(?:\s+([A-Z]{3}))?/.exec(accLine);
  if (!acc) throw new RbStatementFormatError('Ve výpisu chybí číslo účtu.');
  if (acc[2] !== BANK_CODE.RB) throw new NotRbStatementError(`Výpis s neočekávaným kódem banky ${acc[2]}.`);
  const currency = acc[3] ?? /v měně\s+([A-Z]{3})/.exec(joinedText)?.[1] ?? /Výpis z [^\n]{0,80}?č\.\s*\d+\s+([A-Z]{3})/.exec(joinedText)?.[1] ?? 'CZK';
  const per = /za období:?\s*(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})\s*-\s*(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/.exec(joinedText);
  const from = per ? isoDate(per[1]) : null;
  const to = per ? isoDate(per[2]) : null;
  if (!from || !to || from > to) throw new RbStatementFormatError('Ve výpisu chybí období.');
  const seq = Number(/poř\.\s*č\.\s*(\d+)/i.exec(joinedText)?.[1] ?? /Pořadové č\. výpisu:\s*(\d+)/.exec(joinedText)?.[1] ?? 0);
  const opening = labelled(head, /^Počáteční zůstatek:?$/);
  const closing = labelled(head, /^Konečný zůstatek:?$/);
  if (opening === null || closing === null) throw new RbStatementFormatError('Ve výpisu chybí počáteční nebo konečný zůstatek.');
  const income = labelled(head, /^Příjmy celkem:?$/) ?? 0;
  const expense = Math.abs(labelled(head, /^Výdaje celkem:?$/) ?? 0);
  const fees = Math.abs(labelled(head, /^Poplatky celkem:?$/) ?? 0);

  const warnings: string[] = [];
  const txs: RbPdfTx[] = [];
  let cur: Draft | null = null;
  const flush = () => {
    if (cur) {
      const t = finishTx(cur, currency, warnings);
      if (t) txs.push(t);
    }
    cur = null;
  };
  let ended = false;
  for (const rows of pageRows) {
    if (ended) break;
    // the table header repeats on every page; the movements follow its third row
    const hi = rows.findIndex((r) => tableColumns(r));
    if (hi < 0) continue;
    const cols = tableColumns(rows[hi])!;
    let start = hi + 1;
    while (start < rows.length && /Valuta|Kód transakce/.test(text(rows[start])) && !isoDate(rows[start].items[0]?.s ?? '')) start++;
    for (const r of rows.slice(start)) {
      const t = text(r);
      if (/^(Zpráva pro klienta|Žádné transakce)/.test(t) || /^Strana\b/.test(t) || /^Raiffeisenbank a\.s\./.test(t)) {
        if (!/^Strana\b|^Raiffeisenbank a\.s\./.test(t)) ended = true;
        break;
      }
      const byCol = emptyCells();
      for (const it of r.items) byCol[columnOf(it, cols)].push(it.s);
      const first = clean(byCol.c0[0] ?? '');
      const isDate = !!isoDate(first);
      const isCode = /^\d{4,}$/.test(first);
      if (isDate && (!cur || cur.hasValue || cur.hasCode)) {
        flush();
        cur = { cells: [emptyCells()], slot: 0, hasValue: false, hasCode: false };
      } else if (isDate && cur) {
        cur.slot = 1;
        cur.hasValue = true;
      } else if (isCode && cur) {
        cur.slot = 2;
        cur.hasCode = true;
      }
      if (!cur) continue; // text above the first movement
      const d: Draft = cur;
      while (d.cells.length <= d.slot) d.cells.push(emptyCells());
      const cells = d.cells[d.slot];
      for (const k of Object.keys(byCol) as Col[]) cells[k].push(...byCol[k]);
    }
  }
  flush();

  // fees are charged on top of the booked amount (the "Poplatek" column, negative)
  const sum = round2(txs.reduce((s, t) => s + t.amount + (t.fee ?? 0), 0));
  const diff = round2(closing - opening - sum);
  if (Math.abs(diff) >= 0.01) {
    warnings.push(`Pohyby výpisu č. ${seq} (${from} – ${to}) nesedí na jeho zůstatky (rozdíl ${diff.toFixed(2)} ${currency}) – výpis se nepodařilo přečíst celý.`);
  }
  return {
    number: acc[1],
    currency,
    seq,
    from,
    to,
    opening,
    closing,
    income,
    expense,
    fees,
    txCount: txs.length,
    txs,
    warnings,
  };
}
