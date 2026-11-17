/**
 * Synthetic Raiffeisenbank PDF statements for tests: a minimal PDF with positioned text in the layout
 * of the RB statement (header block with balances, three-row movement table, footer). The text uses
 * the standard Helvetica font with a custom encoding for Czech letters, so pdf.js extracts it as
 * Unicode. Synthetic data only.
 */

export interface SyntheticTx {
  /** ISO dates */
  date: string;
  valueDate?: string;
  code: string;
  category: string;
  type: string;
  amount: number;
  currency?: string;
  fee?: number;
  cpAccount?: string;
  cpName?: string;
  message?: string;
  note?: string;
  vs?: string;
  ks?: string;
  ss?: string;
  /** card payment: adds "PK: …" and "merchant; city; country" to the note */
  card?: { merchant: string; city: string; country: string };
  origAmount?: number;
  origCurrency?: string;
  rate?: number;
  /** wrap the type onto a second line (like long RB types do) */
  wrapType?: string;
}

export interface SyntheticStatement {
  /** account number without the bank code */
  number: string;
  bankCode?: string;
  currency?: string;
  seq: number;
  from: string;
  to: string;
  opening: number;
  /** defaults to opening + Σ(amount + fee) */
  closing?: number;
  /** defaults to the sums of the movements */
  income?: number;
  expense?: number;
  fees?: number;
  txs: SyntheticTx[];
  /** older template: "Přehled" block, dates with spaces, other column positions */
  oldTemplate?: boolean;
  /** movements per page (default 8) */
  perPage?: number;
  /** a document that is not an account statement (e.g. a fee statement) */
  title?: string;
}

// Czech letters missing in WinAnsiEncoding, mapped onto otherwise unused codes
const EXTRA: Record<string, number> = { č: 0xc0, Č: 0xc1, ě: 0xc2, Ě: 0xc3, ř: 0xc4, Ř: 0xc5, ů: 0xc6, Ů: 0xc7, ď: 0xc8, Ď: 0xc9, ť: 0xca, Ť: 0xcb, ň: 0xcc, Ň: 0xcd };
const EXTRA_NAMES = ['ccaron', 'Ccaron', 'ecaron', 'Ecaron', 'rcaron', 'Rcaron', 'uring', 'Uring', 'dcaron', 'Dcaron', 'tcaron', 'Tcaron', 'ncaron', 'Ncaron'];
const WIN: Record<string, number> = { Š: 0x8a, š: 0x9a, Ž: 0x8e, ž: 0x9e, á: 0xe1, é: 0xe9, í: 0xed, ó: 0xf3, ú: 0xfa, ý: 0xfd, Á: 0xc1, É: 0xc9, Í: 0xcd, Ó: 0xd3, Ú: 0xda, Ý: 0xdd, '•': 0x95, '–': 0x96 };

function encode(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = EXTRA[ch] ?? WIN[ch] ?? ch.charCodeAt(0);
    if (code > 0xff) throw new Error(`unsupported character ${ch}`);
    const c = String.fromCharCode(code);
    out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
  }
  return out;
}

/** approximate Helvetica width (for right-aligned amounts) */
const width = (s: string, size: number) => s.length * size * 0.5;

const czDate = (iso: string, spaced: boolean) => {
  const [y, m, d] = iso.split('-').map(Number);
  return spaced ? `${d}. ${m}. ${y}` : `${d}.${m}.${y}`;
};

export function fmtMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return `${sign}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${dec}`;
}

interface Text {
  x: number;
  y: number;
  s: string;
  size?: number;
}

function pagesOf(st: SyntheticStatement): Text[][] {
  const old = !!st.oldTemplate;
  const cur = st.currency ?? 'CZK';
  const code = st.bankCode ?? '5500';
  const col = old ? { c0: 38, c1: 100, c2: 208, c3: 347, fee: 445, amtRight: 557 } : { c0: 42, c1: 118, c2: 216, c3: 364, fee: 426, amtRight: 552 };
  const income = st.income ?? st.txs.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const fees = st.fees ?? -st.txs.reduce((s, t) => s + (t.fee ?? 0), 0);
  const expense = st.expense ?? -st.txs.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) + fees;
  const closing = st.closing ?? Math.round((st.opening + st.txs.reduce((s, t) => s + t.amount + (t.fee ?? 0), 0)) * 100) / 100;
  const perPage = st.perPage ?? 8;
  const right = (x: number, y: number, s: string): Text => ({ x: x - width(s, 7), y, s });
  const footer = (p: number, n: number): Text[] => [
    { x: 521, y: 60, s: `Strana ${p} / ${n}` },
    { x: 41, y: 37, s: 'Raiffeisenbank a.s., Hvězdova 1716/2b, 140 78 Praha 4' },
  ];
  const tableHeader = (y: number): Text[] => [
    { x: col.c0, y, s: 'Datum' },
    { x: col.c1, y, s: 'Kategorie transakce' },
    { x: col.c2, y, s: 'Typ transakce' },
    { x: col.c3, y, s: 'VS' },
    { x: col.fee, y, s: 'Poplatek' },
    { x: col.amtRight - 70, y, s: 'Částka' },
    { x: col.c0, y: y - 10, s: 'Valuta' },
    { x: col.c1, y: y - 10, s: 'Číslo protiúčtu' },
    { x: col.c2, y: y - 10, s: 'Zpráva' },
    { x: col.c3, y: y - 10, s: 'KS' },
    { x: col.amtRight - 70, y: y - 10, s: 'Původní částka' },
    { x: col.c0, y: y - 21, s: 'Kód transakce' },
    { x: col.c1, y: y - 21, s: 'Název protiúčtu' },
    { x: col.c2, y: y - 21, s: 'Poznámka' },
    { x: col.c3, y: y - 21, s: 'SS' },
    { x: col.amtRight - 70, y: y - 21, s: 'Kurz' },
  ];
  const chunks: SyntheticTx[][] = [];
  for (let i = 0; i < st.txs.length; i += perPage) chunks.push(st.txs.slice(i, i + perPage));
  if (!chunks.length) chunks.push([]);
  const pages: Text[][] = [];
  chunks.forEach((txs, pi) => {
    const p: Text[] = [];
    let y: number;
    const title = st.title ?? 'Výpis z běžného účtu';
    if (pi === 0) {
      if (old) {
        p.push({ x: 244, y: 808, s: `${title} č. ${st.number} ${cur}` });
        p.push({ x: 328, y: 792, s: `Pořadové č. výpisu: ${st.seq} za období: ${czDate(st.from, true)} - ${czDate(st.to, true)}` });
        p.push({ x: 35, y: 752, s: 'Přehled' });
      } else {
        p.push({ x: 417, y: 801, s: title });
        p.push({ x: 388, y: 787, s: `poř. č. ${st.seq} za období ${czDate(st.from, false)} - ${czDate(st.to, false)}` });
        p.push({ x: 38, y: 760, s: 'Banka inspirovaná klienty' });
      }
      p.push({ x: 42, y: 722, s: 'Číslo účtu:' }, { x: 158, y: 722, s: `${st.number}/${code} ${cur}` });
      p.push({ x: 42, y: 709, s: 'Název účtu:' }, { x: 187, y: 709, s: 'Testovací účet' });
      p.push({ x: 435, y: 685, s: 'Jan Testovací' }, { x: 444, y: 674, s: 'Ukázková 1' }, { x: 503, y: 663, s: 'Praha' }, { x: 501, y: 652, s: '11000' });
      const lines: [string, number][] = [
        ['Počáteční zůstatek:', st.opening],
        ['Příjmy celkem:', income],
        ['Výdaje celkem:', expense],
        ['Konečný zůstatek:', closing],
        ['Pohledávky po splatnosti:', 0],
        ['Poplatky celkem:', fees],
      ];
      lines.forEach(([l, v], i) => p.push({ x: 42, y: 649 - i * 11, s: l }, right(270, 649 - i * 11, fmtMoney(v))));
      if (old) p.push({ x: 35, y: 534, s: 'Výpis pohybů' });
      p.push(...tableHeader(old ? 509 : 550));
      y = (old ? 509 : 550) - 50;
    } else {
      p.push({ x: 417, y: 801, s: title }, { x: 400, y: 770, s: `Účet: ${st.number}/${code} v měně ${cur}` });
      p.push(...tableHeader(724));
      y = 724 - 50;
    }
    if (!st.txs.length) p.push({ x: 247, y, s: 'Žádné transakce' });
    for (const t of txs) {
      const curT = t.currency ?? cur;
      p.push({ x: col.c0, y, s: czDate(t.date, old) }, { x: col.c1, y, s: t.category }, { x: col.c2, y, s: t.type });
      if (t.vs) p.push({ x: col.c3, y, s: t.vs });
      if (t.fee) p.push({ x: col.fee + 4, y, s: fmtMoney(t.fee) });
      p.push(right(col.amtRight, y, `${fmtMoney(t.amount)} ${curT}`));
      if (t.wrapType) {
        y -= 9;
        p.push({ x: col.c2, y, s: t.wrapType });
      }
      y -= 11;
      if (t.valueDate) p.push({ x: col.c0, y, s: czDate(t.valueDate, old) });
      if (t.cpAccount) p.push({ x: col.c1, y, s: t.cpAccount });
      if (t.message) p.push({ x: col.c2, y, s: t.message });
      if (t.ks) p.push({ x: col.c3, y, s: t.ks });
      if (t.origAmount !== undefined) p.push(right(col.amtRight, y, `${fmtMoney(t.origAmount)} ${t.origCurrency}`));
      y -= 11;
      // the older template prints the note a point above the code
      p.push({ x: col.c0, y, s: t.code });
      if (t.cpName) p.push({ x: col.c1, y, s: t.cpName });
      const noteY = old ? y + 1 : y;
      if (t.card) p.push({ x: col.c2, y: noteY, s: 'PK: 123456XXXXXX7890' });
      else if (t.note) p.push({ x: col.c2, y: noteY, s: t.note });
      if (t.ss) p.push({ x: col.c3, y, s: t.ss });
      if (t.rate !== undefined) p.push(right(col.amtRight, y, String(t.rate)));
      if (t.card) {
        y -= 9;
        p.push({ x: col.c2, y, s: `${t.card.merchant}; ${t.card.city}; ${t.card.country}` });
      }
      y -= 17;
    }
    if (pi === chunks.length - 1) {
      p.push({ x: 43, y: Math.min(y, 200), s: 'Zpráva pro klienta' });
      p.push({ x: 43, y: Math.min(y, 200) - 9, s: 'Vklad na tomto účtu podléhá ochraně.' });
    }
    p.push(...footer(pi + 1, chunks.length));
    pages.push(p);
  });
  return pages;
}

/** Builds the PDF bytes. */
export function rbStatementPdf(st: SyntheticStatement): Uint8Array {
  const pages = pagesOf(st);
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [192 ${EXTRA_NAMES.map((n) => `/${n}`).join(' ')}] >> >>`,
  );
  const kids: number[] = [];
  for (const texts of pages) {
    const content = texts.map((t) => `BT /F1 ${t.size ?? 7} Tf ${t.x.toFixed(1)} ${t.y.toFixed(1)} Td (${encode(t.s)}) Tj ET`).join('\n');
    const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
