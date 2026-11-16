/**
 * Generates the bundled demo bank statements (demo/fio, demo/kb, demo/rb) for the accounts module:
 * a fictitious household with a KB current account (salary, rent, utilities), a Raiffeisenbank card
 * account with a linked savings account, and a Fio savings account. Deposits to Degiro and XTB match
 * the demo investment portfolio. Deterministic (seeded), no network access.
 *
 * Usage: npm run demo:banks [YYYY-MM-DD]   (end date, default 2026-10-24 like the XTB demo export)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '2023-01-01';
const END = process.argv[2] ?? '2026-10-24';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'demo');

let seed = 20230102;
function rnd(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a: number, b: number) => a + (b - a) * rnd();
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const r2 = (x: number) => Math.round(x * 100) / 100;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * 86400000);
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const ymd = (d: string) => d.replace(/-/g, '');
const cz = (n: number) => n.toFixed(2).replace('.', ',');
const monthEnd = (y: number, m: number) => iso(Date.UTC(y, m, 0));
const pad = (n: number) => String(n).padStart(2, '0');

/** Business day on or after the date (weekends only) */
function workday(d: string): string {
  let x = d;
  while ([0, 6].includes(new Date(`${x}T00:00:00Z`).getUTCDay())) x = addDays(x, 1);
  return x;
}

function months(): { y: number; m: number }[] {
  const out: { y: number; m: number }[] = [];
  for (let y = Number(START.slice(0, 4)), m = Number(START.slice(5, 7)); `${y}-${pad(m)}` <= END.slice(0, 7); m === 12 ? ((m = 1), y++) : m++) out.push({ y, m });
  return out;
}

const KB = { number: '19-2000145398', code: '0100' };
const RB = { number: '1234567890', code: '5500', name: 'eKonto SMART' };
const RBS = { number: '1234567891', code: '5500', name: 'Spořicí účet' };
const FIO = { number: '2101234567', code: '2010' };
const DEGIRO_ACC = '1000123456/5800';
const XTB_ACC = '2501234567/2010';

interface Tx {
  date: string;
  amount: number;
  type: string;
  category?: string;
  cpAccount?: string;
  cpName?: string;
  merchant?: string;
  city?: string;
  vs?: string;
  ks?: string;
  message?: string;
  note?: string;
  id: string;
}

const kb: Tx[] = [];
const rb: Tx[] = [];
const rbs: Tx[] = [];
const fio: Tx[] = [];
let idSeq = 1000;
const nextId = (len: number) => String(++idSeq * 7919 + 10 ** (len - 1)).slice(0, len);

const GROCERIES = ['ALBERT HYPERMARKET', 'LIDL DEKUJEME ZA NAKUP', 'KAUFLAND PRAHA', 'BILLA', 'PENNY MARKET', 'ROHLIK.CZ'];
const EATING = ['WOLT', 'MCDONALDS', 'BISTRO NA ROHU', 'STARBUCKS', 'FOODORA'];
const FUEL = ['SHELL', 'OMV', 'MOL'];
const SHOPS = ['ALZA.CZ', 'IKEA', 'DM DROGERIE', 'AMAZON EU', 'DATART'];
const HEALTH = ['DR.MAX LEKARNA', 'BENU LEKARNA'];

for (const { y, m } of months()) {
  const mm = `${y}-${pad(m)}`;
  const last = monthEnd(y, m) < END ? monthEnd(y, m) : END;
  const d = (day: number) => {
    const x = workday(`${mm}-${pad(Math.min(day, Number(last.slice(8))))}`);
    return x <= END ? x : END;
  };
  const yearIdx = y - 2023;
  // --- KB current account: salary and regular payments ---
  kb.push({ date: d(12), amount: 62000 + yearIdx * 3000, type: 'Příchozí úhrada', cpAccount: '2700112233/2010', cpName: 'ACME SOFTWARE S.R.O.', vs: `${y}${pad(m)}`, message: 'MZDA', id: nextId(16) });
  kb.push({ date: d(1), amount: -15500, type: 'Trvalý příkaz', cpAccount: '107-9988776655/0100', cpName: 'BYTOVE DRUZSTVO LETNA', vs: '1203', message: 'Nájem byt', id: nextId(16) });
  kb.push({ date: d(15), amount: -r2(between(1700, 2600)), type: 'Odeslané inkaso', cpAccount: '35-4400220033/0100', cpName: 'ČEZ Prodej, a.s.', vs: '8800123456', id: nextId(16) });
  kb.push({ date: d(20), amount: -599, type: 'Odeslané inkaso', cpAccount: '2000400404/0300', cpName: 'O2 Czech Republic a.s.', vs: '5500123', id: nextId(16) });
  kb.push({ date: last, amount: -99, type: 'Poplatek za tarif', id: nextId(14) });
  kb.push({ date: d(13), amount: -24000, type: 'Trvalý příkaz', cpAccount: `${RB.number}/${RB.code}`, cpName: 'JAN NOVAK', message: 'Kapesné na kartu', id: nextId(16) });
  kb.push({ date: d(13), amount: -5000, type: 'Trvalý příkaz', cpAccount: `${FIO.number}/${FIO.code}`, cpName: 'JAN NOVAK', message: 'Spoření', id: nextId(16) });
  if (mm >= '2023-02') kb.push({ date: d(5), amount: -700, type: 'Trvalý příkaz', cpAccount: DEGIRO_ACC, cpName: 'flatexDEGIRO Bank AG', message: 'DEGIRO vklad', id: nextId(16) });
  if (mm === '2023-01') kb.push({ date: d(5), amount: -9000, type: 'Odchozí úhrada', cpAccount: DEGIRO_ACC, cpName: 'flatexDEGIRO Bank AG', message: 'DEGIRO vklad', id: nextId(16) });
  if (mm === '2023-03') kb.push({ date: d(1), amount: -60000, type: 'Odchozí úhrada', cpAccount: XTB_ACC, cpName: 'XTB S.A., organizační složka', message: 'Vklad XTB', id: nextId(16) });
  if (mm >= '2023-04') kb.push({ date: d(2), amount: -5000, type: 'Trvalý příkaz', cpAccount: XTB_ACC, cpName: 'XTB S.A., organizační složka', message: 'Vklad XTB', id: nextId(16) });
  if (m === 12) kb.push({ date: d(18), amount: 30000 + yearIdx * 2000, type: 'Příchozí úhrada', cpAccount: '2700112233/2010', cpName: 'ACME SOFTWARE S.R.O.', message: 'ODMENA', id: nextId(16) });
  if (m === 3) kb.push({ date: d(10), amount: -4800, type: 'Odchozí úhrada', cpAccount: '19-1234560287/0710', cpName: 'Finanční úřad', vs: '7701234567', message: 'Daň z příjmů', id: nextId(16) });

  // --- RB card account: everyday spending ---
  const card = (date: string, name: string, lo: number, hi: number, city = 'PRAHA', type = 'Platba kartou') =>
    rb.push({ date, amount: -r2(between(lo, hi)), type, category: 'Platba kartou', merchant: name, city, message: `PK: 5168 **** **** 1234`, id: nextId(10) });
  for (let day = 1; day <= Number(last.slice(8)); day++) {
    const date = `${mm}-${pad(day)}`;
    if (date > END) break;
    if (rnd() < 0.45) card(date, pick(GROCERIES), 120, 1400);
    if (rnd() < 0.12) card(date, pick(EATING), 150, 650, 'PRAHA', pick(['Platba kartou', 'Platba kartou Google Pay']));
    if (rnd() < 0.06) card(date, pick(FUEL), 900, 1900, pick(['PRAHA', 'BRNO', 'BENESOV']));
    if (rnd() < 0.05) card(date, pick(SHOPS), 300, 3500, 'PRAHA', 'Platba na internetu');
    if (rnd() < 0.03) card(date, pick(HEALTH), 90, 700);
  }
  card(d(3), 'NETFLIX.COM', 259, 259, 'LOS GATOS', 'Platba na internetu');
  card(d(7), 'SPOTIFY', 199, 199, 'STOCKHOLM', 'Platba na internetu');
  if (m === 7) card(d(8), 'BOOKING.COM', 6000, 14000, 'AMSTERDAM', 'Platba na internetu');
  if (rnd() < 0.5) rb.push({ date: d(rnd() < 0.5 ? 9 : 22), amount: -2000, type: 'Výběr z bankomatu', category: 'Výběr hotovosti', city: 'PRAHA', id: nextId(10) });
  rb.push({ date: d(13), amount: 24000, type: 'Příchozí úhrada', category: 'Platba', cpAccount: `${KB.number}/${KB.code}`, cpName: 'NOVAK JAN', message: 'Kapesné na kartu', id: nextId(10) });
  // "Inteligentní spoření": the balance above 3 000 goes to savings at month end
  const rbBal = rb.reduce((s, t) => s + t.amount, 0);
  const sweep = Math.max(0, Math.floor((rbBal - 3000) / 100) * 100);
  if (sweep > 0) {
    const id = nextId(10);
    rb.push({ date: last, amount: -sweep, type: 'Inteligentní spoření - převod prostředků na spořicí účet', category: 'Ostatní', cpAccount: `${RBS.number}/${RBS.code}`, id });
    rbs.push({ date: last, amount: sweep, type: 'Inteligentní spoření - převod prostředků na spořicí účet', category: 'Ostatní', cpAccount: `${RB.number}/${RB.code}`, id: nextId(10) });
  }

  // --- interest on savings ---
  const rbsBal = rbs.reduce((s, t) => s + t.amount, 0);
  const rbsInt = r2((rbsBal * 0.03) / 12);
  if (rbsInt > 0) {
    rbs.push({ date: last, amount: rbsInt, type: 'Kladný úrok', category: 'Úrok', id: nextId(10) });
    rbs.push({ date: last, amount: -r2(rbsInt * 0.15), type: 'Daň z úroků', category: 'Daň', id: nextId(10) });
  }
  fio.push({ date: d(14), amount: 5000, type: 'Bezhotovostní příjem', cpAccount: KB.number, cpName: 'NOVAK JAN', message: 'Spoření', id: nextId(11) });
  const fioBal = fio.reduce((s, t) => s + t.amount, 0);
  const fioInt = r2((fioBal * 0.035) / 12);
  if (fioInt > 0 && last.slice(8) === monthEnd(y, m).slice(8)) {
    fio.push({ date: last, amount: fioInt, type: 'Připsaný úrok', id: nextId(11) });
    fio.push({ date: last, amount: -r2(fioInt * 0.15), type: 'Odvod daně z úroků', id: nextId(11) });
  }
}
// Fio has the counterparty number and the bank code in separate columns
for (const t of fio) if (t.cpAccount === KB.number) t.cpAccount = `${KB.number}/${KB.code}`;

const byDate = (a: Tx, b: Tx) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
for (const l of [kb, rb, rbs, fio]) l.sort(byDate);

const sumUpTo = (l: Tx[], date: string) => r2(l.filter((t) => t.date <= date).reduce((s, t) => s + t.amount, 0));
/** fictitious opening balances on 31 Dec 2022 */
const KB_OPEN = 35000;
const FIO_OPEN = 20000;

// --- Fio: one statement per month (UTF-8 with BOM, ";" and quotes) ---
function fioStatement(n: number, from: string, to: string): string {
  const q = (v: string | number | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = fio.filter((t) => t.date >= from && t.date <= to);
  const open = FIO_OPEN + sumUpTo(fio, addDays(from, -1));
  const close = FIO_OPEN + sumUpTo(fio, to);
  const inc = rows.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const out = rows.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const lines = [
    q(`Výpis č. ${n}/${from.slice(0, 4)} z účtu "${FIO.number}/${FIO.code}"`),
    q('Majitel účtu: Novák Jan, Ukázková 1, Praha'),
    q(`Vytvořeno v aplikaci Internetbanking 2.0: ${dmy(to)} 08:00:00`),
    q(`Období: ${dmy(from)} - ${dmy(to)}`),
    q(`Počáteční stav účtu k ${dmy(from)}: ${cz(open)} CZK`),
    q(`Koncový stav účtu k ${dmy(to)}: ${cz(close)} CZK`),
    q(`Suma příjmů: ${cz(inc)} CZK`),
    q(`Suma výdajů: ${cz(out)} CZK`),
    '',
    ['ID operace', 'Datum', 'Objem', 'Měna', 'Protiúčet', 'Název protiúčtu', 'Kód banky', 'Název banky', 'KS', 'VS', 'SS', 'Poznámka', 'Zpráva pro příjemce', 'Typ', 'Provedl', 'Upřesnění', 'Poznámka', 'BIC', 'ID pokynu']
      .map(q)
      .join(';'),
    ...rows.map((t) => {
      const [acc, code] = (t.cpAccount ?? '').split('/');
      return [t.id, dmy(t.date), cz(t.amount), 'CZK', acc, t.cpName, code, code === '0100' ? 'Komerční banka, a.s.' : '', '', t.vs, '', t.message, t.message, t.type, '', '', '', '', t.cpAccount ? nextId(11) : '']
        .map(q)
        .join(';');
    }),
  ];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// --- KB: one statement per year (windows-1250, ";" without quotes, padded to 19 fields) ---
const CP1250: Record<string, number> = {
  á: 0xe1, č: 0xe8, ď: 0xef, é: 0xe9, ě: 0xec, í: 0xed, ň: 0xf2, ó: 0xf3, ř: 0xf8, š: 0x9a, ť: 0x9d, ú: 0xfa, ů: 0xf9, ý: 0xfd, ž: 0x9e,
  Á: 0xc1, Č: 0xc8, Ď: 0xcf, É: 0xc9, Ě: 0xcc, Í: 0xcd, Ň: 0xd2, Ó: 0xd3, Ř: 0xd8, Š: 0x8a, Ť: 0x8d, Ú: 0xda, Ů: 0xd9, Ý: 0xdd, Ž: 0x8e,
};
function cp1250(text: string): Buffer {
  return Buffer.from([...text].map((ch) => (ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : (CP1250[ch] ?? 0x3f))));
}
function kbStatement(from: string, to: string): Buffer {
  const W = 19;
  const line = (...cells: (string | number | undefined)[]) => [...cells.map((c) => String(c ?? '').replace(/;/g, ',')), ...Array(W).fill('')].slice(0, W).join(';');
  const rows = kb.filter((t) => t.date >= from && t.date <= to).reverse();
  const lines = [
    line('KB+, vypis v csv. formatu'),
    line('Datum vytvoreni souboru', dmy(to)),
    line(),
    line('Cislo uctu', KB.number),
    line('Mena uctu / Hlavni mena uctu', 'CZK'),
    line('Mena vypisu'),
    line('IBAN', 'CZ0001000000192000145398'),
    line('Nazev uctu', 'JAN NOVÁK'),
    line('Vypis od', dmy(from)),
    line('Vypis do', dmy(to)),
    line('Cislo vypisu'),
    line('Pocet polozek', rows.length),
    line('Mena', 'CZK', 'EUR', 'USD', 'GBP'),
    line('Pocatecni zustatek', cz(KB_OPEN + sumUpTo(kb, addDays(from, -1)))),
    line('Konecny zustatek', cz(KB_OPEN + sumUpTo(kb, to))),
    line(),
    line('Datum zauctovani', 'Datum provedeni', 'Protistrana', 'Nazev protiuctu', 'Castka', 'Mena', 'Originalni castka', 'Originalni mena', 'Smenny kurz', 'VS', 'KS', 'SS', 'Identifikace transakce', 'Typ transakce', 'Popis pro me', 'Zprava pro prijemce', 'Reference platby', 'BIC / SWIFT', 'Poplatek'),
    ...rows.map((t) => line(dmy(t.date), dmy(t.date), t.cpAccount, t.cpName, cz(t.amount), 'CZK', '', '', '', t.vs ?? '0', t.ks ?? '0', '0', t.id, t.type, '', t.message, '', '', '')),
  ];
  return cp1250(lines.join('\r\n') + '\r\n');
}

// --- Raiffeisenbank: transaction history of one account (UTF-8 with BOM, ";" and quotes) ---
function rbExport(acc: { number: string; code: string; name: string }, list: Tx[]): string {
  const q = (v: string | number | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Datum provedení', 'Datum zaúčtování', 'Číslo účtu', 'Název účtu', 'Kategorie transakce', 'Číslo protiúčtu', 'Název protiúčtu', 'Typ transakce', 'Zpráva', 'Poznámka', 'VS', 'KS', 'SS', 'Zaúčtovaná částka', 'Měna účtu', 'Původní částka', 'Původní měna', 'Poplatky', 'Id transakce', 'Vlastní poznámka', 'Název obchodníka', 'Město'];
  const rows = [...list].reverse().map((t) => {
    // card payments are booked a day or two later
    const booked = t.category === 'Platba kartou' ? addDays(t.date, 1) : t.date;
    return [dmy(t.date), dmy(booked > END ? t.date : booked), `${acc.number}/${acc.code}`, acc.name, t.category, t.cpAccount, t.cpName, t.type, t.message, '', t.vs, t.ks, '', cz(t.amount), 'CZK', '', '', '', t.id, '', t.merchant, t.city].map(q).join(';');
  });
  return '﻿' + [header.map(q).join(';'), ...rows].join('\r\n') + '\r\n';
}

for (const d of ['fio', 'kb', 'rb']) rmSync(join(OUT, d), { recursive: true, force: true });
for (const d of ['fio', 'kb', 'rb']) mkdirSync(join(OUT, d), { recursive: true });
let n = 0;
let prevYear = 0;
for (const { y, m } of months()) {
  if (y !== prevYear) {
    n = 0;
    prevYear = y;
  }
  const from = `${y}-${pad(m)}-01`;
  const to = monthEnd(y, m) < END ? monthEnd(y, m) : END;
  writeFileSync(join(OUT, 'fio', `Vypis_z_uctu-${FIO.number}_${ymd(from)}-${ymd(to)}_cislo-${++n}.csv`), fioStatement(n, from, to));
}
for (let y = Number(START.slice(0, 4)); y <= Number(END.slice(0, 4)); y++) {
  const from = `${y}-01-01`;
  const to = `${y}-12-31` < END ? `${y}-12-31` : END;
  writeFileSync(join(OUT, 'kb', `Vypis_${KB.number.replace('-', '')}_${ymd(from)}_${ymd(to)}.csv`), kbStatement(from, to));
}
writeFileSync(join(OUT, 'rb', `Pohyby_${RB.number}_${ymd(START)}_${ymd(END)}.csv`), rbExport(RB, rb));
writeFileSync(join(OUT, 'rb', `Pohyby_${RBS.number}_${ymd(START)}_${ymd(END)}.csv`), rbExport(RBS, rbs));
console.log(`demo bank statements: KB ${kb.length}, RB ${rb.length}, RB savings ${rbs.length}, Fio ${fio.length} movements`);
