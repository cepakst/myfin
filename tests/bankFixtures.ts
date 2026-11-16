/** Builders of synthetic Fio, KB and Raiffeisenbank statement exports (fictitious data only). */

const CP1250: Record<string, number> = {
  á: 0xe1, č: 0xe8, ď: 0xef, é: 0xe9, ě: 0xec, í: 0xed, ň: 0xf2, ó: 0xf3, ř: 0xf8, š: 0x9a, ť: 0x9d, ú: 0xfa, ů: 0xf9, ý: 0xfd, ž: 0x9e,
  Á: 0xc1, Č: 0xc8, Ď: 0xcf, É: 0xc9, Ě: 0xcc, Í: 0xcd, Ň: 0xd2, Ó: 0xd3, Ř: 0xd8, Š: 0x8a, Ť: 0x8d, Ú: 0xda, Ů: 0xd9, Ý: 0xdd, Ž: 0x8e,
};
export function cp1250(text: string): Buffer {
  return Buffer.from([...text].map((ch) => (ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : (CP1250[ch] ?? 0x3f))));
}

export const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
export const ymd = (d: string) => d.replace(/-/g, '');
/** 1234.5 -> "1 234,50" style is not needed; plain Czech decimal comma */
export const cz = (n: number) => n.toFixed(2).replace('.', ',');
const q = (v: string | number | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export interface BankRow {
  id: string;
  date: string;
  amount: number;
  type: string;
  /** `number/code` (KB, RB) or `number` plus `cpBank` (Fio) */
  cp?: string;
  cpBank?: string;
  cpName?: string;
  vs?: string;
  ks?: string;
  message?: string;
  note?: string;
  merchant?: string;
  city?: string;
  category?: string;
  /** Fio "Upřesnění" */
  detail?: string;
  /** Fio first "Poznámka" column */
  ident?: string;
  cur?: string;
  valueDate?: string;
  origAmount?: number;
  origCur?: string;
}

export interface FioOpts {
  account: string;
  n?: number;
  from: string;
  to: string;
  open: number;
  close: number;
  cur?: string;
  rows: BankRow[];
}

export function fioCsv(o: FioOpts): string {
  const cur = o.cur ?? 'CZK';
  const lines = [
    q(`Výpis č. ${o.n ?? 1}/${o.from.slice(0, 4)} z účtu "${o.account}/2010"`),
    q('Majitel účtu: Test Owner, Fictional 1, Praha'),
    q(`Vytvořeno v aplikaci Internetbanking 2.0: ${dmy(o.to)} 08:00:00`),
    q(`Období: ${dmy(o.from)} - ${dmy(o.to)}`),
    q(`Počáteční stav účtu k ${dmy(o.from)}: ${cz(o.open)} ${cur}`),
    q(`Koncový stav účtu k ${dmy(o.to)}: ${cz(o.close)} ${cur}`),
    q('Suma příjmů: 0,00 ' + cur),
    q('Suma výdajů: 0,00 ' + cur),
    '',
    ['ID operace', 'Datum', 'Objem', 'Měna', 'Protiúčet', 'Název protiúčtu', 'Kód banky', 'Název banky', 'KS', 'VS', 'SS', 'Poznámka', 'Zpráva pro příjemce', 'Typ', 'Provedl', 'Upřesnění', 'Poznámka', 'BIC', 'ID pokynu'].map(q).join(';'),
    ...o.rows.map((t) =>
      [t.id, dmy(t.date), cz(t.amount), t.cur ?? cur, t.cp ?? '', t.cpName ?? '', t.cpBank ?? '', '', t.ks ?? '', t.vs ?? '', '', t.ident ?? '', t.message ?? '', t.type, '', t.detail ?? '', t.note ?? '', '', '']
        .map(q)
        .join(';'),
    ),
  ];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export interface KbOpts {
  account: string;
  from: string;
  to: string;
  open: number;
  close: number;
  cur?: string;
  rows: BankRow[];
}

export function kbCsv(o: KbOpts): Buffer {
  const W = 19;
  const line = (...cells: (string | number | undefined)[]) => [...cells.map((c) => String(c ?? '').replace(/;/g, ',')), ...Array(W).fill('')].slice(0, W).join(';');
  const cur = o.cur ?? 'CZK';
  const lines = [
    line('KB+, vypis v csv. formatu'),
    line('Datum vytvoreni souboru', dmy(o.to)),
    line(),
    line('Cislo uctu', o.account),
    line('Mena uctu / Hlavni mena uctu', cur),
    line('Mena vypisu'),
    line('IBAN', 'CZ0000000000000000000000'),
    line('Nazev uctu', 'TEST OWNER'),
    line('Vypis od', dmy(o.from)),
    line('Vypis do', dmy(o.to)),
    line('Cislo vypisu'),
    line('Pocet polozek', o.rows.length),
    line('Mena', 'CZK', 'EUR', 'USD', 'GBP'),
    line('Pocatecni zustatek', cz(o.open)),
    line('Konecny zustatek', cz(o.close)),
    line(),
    line('Datum zauctovani', 'Datum provedeni', 'Protistrana', 'Nazev protiuctu', 'Castka', 'Mena', 'Originalni castka', 'Originalni mena', 'Smenny kurz', 'VS', 'KS', 'SS', 'Identifikace transakce', 'Typ transakce', 'Popis pro me', 'Zprava pro prijemce', 'Reference platby', 'BIC / SWIFT', 'Poplatek'),
    ...o.rows.map((t) =>
      line(dmy(t.date), dmy(t.valueDate ?? t.date), t.cp, t.cpName, cz(t.amount), t.cur ?? cur, t.origAmount === undefined ? '' : cz(t.origAmount), t.origCur ?? '', '', t.vs ?? '0', t.ks ?? '0', '0', t.id, t.type, t.note, t.message, '', '', ''),
    ),
  ];
  return cp1250(lines.join('\r\n') + '\r\n');
}

export interface RbOpts {
  account: string;
  name: string;
  cur?: string;
  rows: BankRow[];
  /** rows of a second account in the same file */
  other?: { account: string; name: string; rows: BankRow[] };
}

export const RB_HEADER = ['Datum provedení', 'Datum zaúčtování', 'Číslo účtu', 'Název účtu', 'Kategorie transakce', 'Číslo protiúčtu', 'Název protiúčtu', 'Typ transakce', 'Zpráva', 'Poznámka', 'VS', 'KS', 'SS', 'Zaúčtovaná částka', 'Měna účtu', 'Původní částka', 'Původní měna', 'Poplatky', 'Id transakce', 'Vlastní poznámka', 'Název obchodníka', 'Město'];

export function rbCsv(o: RbOpts): string {
  const cur = o.cur ?? 'CZK';
  const mk = (account: string, name: string, rows: BankRow[]) =>
    rows.map((t) => [dmy(t.valueDate ?? t.date), dmy(t.date), `${account}/5500`, name, t.category ?? '', t.cp ?? '', t.cpName ?? '', t.type, t.message ?? '', t.ident ?? '', t.vs ?? '', t.ks ?? '', '', cz(t.amount), cur, t.origAmount === undefined ? '' : cz(t.origAmount), t.origCur ?? '', '', t.id, t.note ?? '', t.merchant ?? '', t.city ?? ''].map(q).join(';'));
  const rows = [...mk(o.account, o.name, o.rows), ...(o.other ? mk(o.other.account, o.other.name, o.other.rows) : [])];
  return '﻿' + [RB_HEADER.map(q).join(';'), ...rows].join('\r\n') + '\r\n';
}
