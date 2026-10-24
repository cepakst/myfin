import { basename } from 'node:path';
import ExcelJS from 'exceljs';
import type { FxRates } from '../core/fx.js';
import { profileFor, SITUATION_LABELS, uses16a, type Settings } from '../core/settings.js';
import { SMALL_SALES_LIMIT } from '../core/tax/securities.js';
import { countryName } from '../core/tax/treaties.js';
import type { Ledger, Trade } from '../core/types.js';
import type { Snapshot } from './engine.js';

export interface TaxReportInput {
  year: number;
  snapshot: Snapshot;
  ledger: Ledger;
  fx: FxRates;
  settings: Settings;
}

const SHEET_SALES = 'Prodeje CP';
const SHEET_DIV = 'Dividendy';
const SHEET_INT = 'Úroky';

export const CLASS_TIME_TEST = 'osvobozeno – časový test';
export const CLASS_SMALL = 'osvobozeno – limit 100 000 Kč';
export const CLASS_TAXABLE = 'zdanitelné – § 10';
export const DIV_FOREIGN = 'zahraniční – do přiznání';
export const DIV_CZ = 'česká – zdaněno srážkou';

const FMT_CZK = '#,##0.00';
const FMT_KC = '#,##0';
const FMT_QTY = '#,##0.######';
const FMT_RATE = '0.000###';
const FMT_DATE = 'd.m.yyyy';
const FMT_PCT = '0.0##%';

interface RateInfo {
  rate: number;
  source: string;
}

/** Excel serial-friendly date (ExcelJS writes Date values as UTC) */
const xDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const fxLabel = (m: string) => (m === 'DAILY' ? 'denní kurzy ČNB (ke dni transakce)' : 'jednotný kurz za rok');

function unifiedSourceLabel(src: 'official' | 'override' | 'computed', provisional: boolean): string {
  if (src === 'official') return 'jednotný kurz vyhlášený GFŘ';
  if (src === 'override') return 'jednotný kurz zadaný ručně v aplikaci';
  return `průměr kurzů ČNB k poslednímu dni měsíců – vypočten aplikací stejným postupem jako GFŘ, ${provisional ? 'předběžný (rok neskončil nebo GFŘ kurz nevyhlásilo)' : 'oficiální kurz GFŘ není v aplikaci uložen – ověřte jej'}`;
}

/**
 * Rate that converts `local` (in `currency`, dated `date`) to the tax CZK value `czk` used by the app.
 * Normally the configured CNB rate; when the broker settled the trade in CZK (XTB CZK account) the effective settlement rate.
 */
class RateBook {
  readonly used = new Map<string, { currency: string; kind: string; period: string; rate: number; source: string }>();
  constructor(private fx: FxRates) {}

  info(currency: string, date: string, local: number, czk: number): RateInfo {
    if (currency === 'CZK') return { rate: 1, source: 'CZK' };
    const year = Number(date.slice(0, 4));
    let rate: number;
    let source: string;
    let kind: string;
    let period: string;
    let detail: string;
    try {
      if (this.fx.methodFor(year) === 'DAILY') {
        rate = this.fx.daily(currency, date);
        kind = 'denní kurz ČNB';
        period = date;
        source = `ČNB ${date.split('-').reverse().join('. ').replace(/^0/, '')}`;
        detail = 'kurz devizového trhu ČNB platný ke dni transakce (poslední vyhlášený)';
      } else {
        const u = this.fx.unified(currency, year);
        rate = u.rate;
        kind = 'jednotný kurz';
        period = String(year);
        source = `jednotný ${year}`;
        detail = unifiedSourceLabel(u.source, u.provisional);
      }
    } catch {
      rate = NaN;
      kind = '';
      period = '';
      source = '';
      detail = '';
    }
    // the app used a different value (e.g. CZK settlement at XTB) – show the effective rate
    if (!Number.isFinite(rate) || (local !== 0 && Math.abs(local * rate - czk) > 0.01 + Math.abs(czk) * 1e-6)) {
      rate = local !== 0 ? Math.round((czk / local) * 1e6) / 1e6 : 0;
      kind = 'kurz vypořádání brokera';
      period = date;
      source = 'vypořádáno v CZK (XTB)';
      detail = 'účet vedený v CZK – broker přepočetl obchod vlastním kurzem; použita skutečně vypořádaná částka v CZK';
    }
    const key = `${currency}|${kind}|${period}`;
    if (!this.used.has(key)) this.used.set(key, { currency, kind, period, rate, source: detail });
    return { rate, source };
  }
}

type Cell = ExcelJS.CellValue;
const f = (formula: string, result: number | string): Cell => ({ formula, result }) as Cell;

function styleHeader(ws: ExcelJS.Worksheet, rowNo: number) {
  const row = ws.getRow(rowNo);
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', wrapText: true };
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EAF6' } };
    c.border = { bottom: { style: 'thin' } };
  });
}

function title(ws: ExcelJS.Worksheet, text: string, sub?: string) {
  ws.addRow([text]).font = { bold: true, size: 14 };
  if (sub) ws.addRow([sub]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
}

interface Column {
  header: string;
  width: number;
  fmt?: string;
}

function table(ws: ExcelJS.Worksheet, cols: Column[], rows: Cell[][]): { first: number; last: number; col: (i: number) => string } {
  const headerRow = ws.rowCount + 1;
  ws.addRow(cols.map((c) => c.header));
  styleHeader(ws, headerRow);
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(col.width ?? 0, c.width);
  });
  for (const r of rows) {
    const row = ws.addRow(r);
    cols.forEach((c, i) => {
      if (c.fmt) row.getCell(i + 1).numFmt = c.fmt;
    });
  }
  const first = headerRow + 1;
  const last = Math.max(first, headerRow + rows.length);
  ws.views = [{ state: 'frozen', ySplit: headerRow }];
  if (rows.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + rows.length, column: cols.length } };
  return { first, last, col: (i: number) => ws.getColumn(i).letter };
}

/** Absolute range of column `letter` on `sheet` between rows */
const rng = (sheet: string, letter: string, first: number, last: number) => `'${sheet}'!$${letter}$${first}:$${letter}$${last}`;

export async function buildTaxReport({ year, snapshot: s, ledger, fx, settings }: TaxReportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'My finance';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  const rates = new RateBook(fx);
  const trades = new Map<string, Trade>(ledger.trades.map((t) => [t.id, t]));
  const isin = (id: string) => ledger.instruments.get(id)?.isin ?? '';

  const sec = s.securities.find((x) => x.year === year)!;
  const sum = s.taxSummaries.find((x) => x.year === year)!;
  const dap = s.dap.find((x) => x.year === year)!;
  const profile = profileFor(settings, year);
  const use16a = uses16a(settings, year);
  const fxMethod = fx.methodFor(year);

  const wsSum = wb.addWorksheet('Souhrn');
  const wsSales = wb.addWorksheet(SHEET_SALES);
  const wsDiv = wb.addWorksheet(SHEET_DIV);

  // ---------- Prodeje CP ----------
  const rs = s.realizations
    .filter((r) => r.sellDate.startsWith(`${year}-`))
    .sort((a, b) => (a.sellDateTime < b.sellDateTime ? -1 : a.sellDateTime > b.sellDateTime ? 1 : a.acqDate < b.acqDate ? -1 : a.acqDate > b.acqDate ? 1 : 0));
  title(
    wsSales,
    `Prodeje cenných papírů v roce ${year} – párování FIFO`,
    'Každý řádek = část prodeje spárovaná s jedním nákupem (FIFO v rámci účtu u brokera). Částky v Kč = částka v měně × kurz. Výdaje = nákupní cena + poplatky při nákupu i prodeji.',
  );
  const salesCols: Column[] = [
    { header: 'Broker', width: 9 },
    { header: 'Instrument', width: 30 },
    { header: 'ISIN', width: 14 },
    { header: 'Datum nákupu', width: 11, fmt: FMT_DATE },
    { header: 'Datum prodeje', width: 11, fmt: FMT_DATE },
    { header: 'Počet ks', width: 10, fmt: FMT_QTY },
    { header: 'Měna', width: 6 },
    { header: 'Nákupní cena (v měně)', width: 14, fmt: FMT_CZK },
    { header: 'Kurz nákup', width: 10, fmt: FMT_RATE },
    { header: 'Zdroj kurzu nákup', width: 18 },
    { header: 'Nákupní cena Kč', width: 14, fmt: FMT_CZK },
    { header: 'Poplatky nákup Kč', width: 11, fmt: FMT_CZK },
    { header: 'Prodejní cena (v měně)', width: 14, fmt: FMT_CZK },
    { header: 'Kurz prodej', width: 10, fmt: FMT_RATE },
    { header: 'Zdroj kurzu prodej', width: 18 },
    { header: 'Příjem z prodeje Kč', width: 14, fmt: FMT_CZK },
    { header: 'Poplatky prodej Kč', width: 11, fmt: FMT_CZK },
    { header: 'Výdaje celkem Kč', width: 14, fmt: FMT_CZK },
    { header: 'Zisk / ztráta Kč', width: 14, fmt: FMT_CZK },
    { header: 'Držení (dní)', width: 9, fmt: FMT_KC },
    { header: 'Časový test splněn od', width: 12, fmt: FMT_DATE },
    { header: 'Časový test', width: 9 },
    { header: 'Daňové zařazení', width: 26 },
    { header: 'Poznámka', width: 30 },
  ];
  const salesStart = wsSales.rowCount + 2;
  const salesRows: Cell[][] = [];
  const classOf = (timeTest: boolean) => (timeTest ? CLASS_TIME_TEST : sec.smallSalesExempt ? CLASS_SMALL : CLASS_TAXABLE);
  const salesCalc: { proceeds: number; expenses: number; cls: string; timeTest: boolean }[] = [];
  rs.forEach((r, i) => {
    const row = salesStart + i;
    const sellTrade = trades.get(r.tradeId);
    const buyTrade = r.buyTradeId ? trades.get(r.buyTradeId) : undefined;
    const sellRate = rates.info(r.currency, r.sellDate, r.proceedsLocal, r.proceedsCzk);
    const buyRate = buyTrade ? rates.info(buyTrade.currency, r.acqDate, r.costLocal, r.costCzk) : { rate: r.costLocal ? r.costCzk / r.costLocal : 0, source: r.costLocal ? 'přepočteno' : '' };
    const cost = r.costLocal * buyRate.rate;
    const proceeds = r.proceedsLocal * sellRate.rate;
    const expenses = cost + r.buyFeesCzk + r.sellFeesCzk;
    const cls = classOf(r.timeTestPassed);
    salesCalc.push({ proceeds, expenses, cls, timeTest: r.timeTestPassed });
    const notes = [
      r.origin === 'FREE' ? 'bezplatně nabyté akcie (nabývací cena 0)' : '',
      r.origin === 'UNKNOWN' && r.tradeId.startsWith('CC:') ? 'hotovost z korporátní akce (bez nabývací ceny)' : '',
      r.origin === 'UNKNOWN' && !r.tradeId.startsWith('CC:') ? 'chybí nákup v exportech – nabývací cena 0' : '',
      buyTrade && buyTrade.currency !== r.currency ? `nákup v ${buyTrade.currency}` : '',
      sellTrade?.fees.length ? `poplatky prodeje: ${sellTrade.fees.map((x) => `${x.amount.toFixed(2)} ${x.currency}`).join(', ')} (celý obchod)` : '',
    ].filter(Boolean);
    salesRows.push([
      r.broker,
      r.name,
      isin(r.instrumentId),
      xDate(r.acqDate),
      xDate(r.sellDate),
      r.qty,
      r.currency,
      r.costLocal,
      buyRate.rate,
      buyRate.source,
      f(`H${row}*I${row}`, cost),
      r.buyFeesCzk,
      r.proceedsLocal,
      sellRate.rate,
      sellRate.source,
      f(`M${row}*N${row}`, proceeds),
      r.sellFeesCzk,
      f(`K${row}+L${row}+Q${row}`, expenses),
      f(`P${row}-R${row}`, proceeds - expenses),
      r.holdingDays,
      xDate(r.timeTestDate),
      r.timeTestPassed ? 'ano' : 'ne',
      cls,
      notes.join('; '),
    ]);
  });
  const sales = table(wsSales, salesCols, salesRows);
  if (rs.length) {
    wsSales.addRow([]);
    const t = wsSales.addRow(['Celkem']);
    t.font = { bold: true };
    for (const [c, v] of [
      ['P', salesCalc.reduce((a, x) => a + x.proceeds, 0)],
      ['R', salesCalc.reduce((a, x) => a + x.expenses, 0)],
      ['S', salesCalc.reduce((a, x) => a + x.proceeds - x.expenses, 0)],
    ] as const) {
      const cell = t.getCell(c);
      cell.value = f(`SUM(${c}${sales.first}:${c}${sales.last})`, v);
      cell.numFmt = FMT_CZK;
    }
  } else wsSales.addRow(['V tomto roce nebyly prodány žádné cenné papíry.']);

  // ---------- Dividendy ----------
  const pays = s.dividends.filter((d) => d.year === year).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
  title(
    wsDiv,
    `Dividendy přijaté v roce ${year}`,
    'Zahraniční dividendy se uvádějí v přiznání v hrubé výši. Zahraniční daň lze započíst nejvýše do sazby podle smlouvy o zamezení dvojího zdanění. České dividendy jsou zdaněny srážkovou daní a do přiznání se neuvádějí.',
  );
  const divCols: Column[] = [
    { header: 'Broker', width: 9 },
    { header: 'Datum', width: 11, fmt: FMT_DATE },
    { header: 'Instrument', width: 30 },
    { header: 'ISIN', width: 14 },
    { header: 'Stát zdroje', width: 16 },
    { header: 'Měna', width: 6 },
    { header: 'Hrubá dividenda (v měně)', width: 13, fmt: FMT_CZK },
    { header: 'Sražená daň (v měně)', width: 12, fmt: FMT_CZK },
    { header: 'Kurz', width: 10, fmt: FMT_RATE },
    { header: 'Zdroj kurzu', width: 18 },
    { header: 'Hrubá dividenda Kč', width: 13, fmt: FMT_CZK },
    { header: 'Sražená daň Kč', width: 12, fmt: FMT_CZK },
    { header: 'Smluvní sazba', width: 9, fmt: FMT_PCT },
    { header: 'Započitatelná daň Kč', width: 13, fmt: FMT_CZK },
    { header: 'Sraženo nad smluvní sazbu Kč', width: 13, fmt: FMT_CZK },
    { header: 'Zdanění', width: 24 },
    { header: 'Poznámka', width: 24 },
  ];
  const divStart = wsDiv.rowCount + 2;
  const divCalc: { gross: number; withheld: number; credit: number; foreign: boolean; country: string; treaty: number | null }[] = [];
  const divRows: Cell[][] = pays.map((p, i) => {
    const row = divStart + i;
    const base = p.gross !== 0 ? [p.gross, p.grossCzk] : [p.withheld, p.withheldCzk];
    const ri = rates.info(p.currency, p.date, base[0], base[1]);
    const gross = p.gross * ri.rate;
    const withheld = p.withheld * ri.rate;
    const foreign = !p.finalTaxed;
    const treaty = foreign ? p.treatyRate : null;
    const credit = treaty == null ? 0 : Math.max(0, Math.min(withheld, gross * treaty));
    const excess = treaty == null ? 0 : Math.max(0, withheld - gross * treaty);
    divCalc.push({ gross, withheld, credit, foreign, country: p.country, treaty });
    return [
      p.broker,
      xDate(p.date),
      p.name,
      isin(p.instrumentId),
      `${countryName(p.country)} (${p.country})`,
      p.currency,
      p.gross,
      p.withheld,
      ri.rate,
      ri.source,
      f(`G${row}*I${row}`, gross),
      f(`H${row}*I${row}`, withheld),
      treaty ?? (foreign ? 'bez smlouvy' : ''),
      treaty == null ? 0 : f(`MAX(0,MIN(L${row},K${row}*M${row}))`, credit),
      treaty == null ? 0 : f(`MAX(0,L${row}-K${row}*M${row})`, excess),
      foreign ? DIV_FOREIGN : DIV_CZ,
      [p.capitalReturn ? 'vrácení kapitálu – konzervativně jako dividenda' : '', foreign && treaty == null ? 'stát bez smlouvy – zápočet nelze' : ''].filter(Boolean).join('; '),
    ];
  });
  const divT = table(wsDiv, divCols, divRows);
  if (!pays.length) wsDiv.addRow(['V tomto roce nebyly přijaty žádné dividendy.']);

  // per-country summary (Příloha č. 3 is filed per country)
  wsDiv.addRow([]);
  wsDiv.addRow(['Zahraniční dividendy podle států']).font = { bold: true, size: 12 };
  const cHead = wsDiv.rowCount + 1;
  wsDiv.addRow(['Stát', '', '', '', '', '', 'Počet výplat', '', '', '', 'Hrubá dividenda Kč', 'Sražená daň Kč', '', 'Započitatelná daň Kč', 'Sraženo nad smluvní sazbu Kč']);
  styleHeader(wsDiv, cHead);
  const countries = [...new Set(divCalc.filter((d) => d.foreign).map((d) => d.country))].sort();
  const cRange = (letter: string) => `$${letter}$${divT.first}:$${letter}$${divT.last}`;
  for (const c of countries) {
    const ds = divCalc.filter((d) => d.foreign && d.country === c);
    const label = `${countryName(c)} (${c})`;
    const r = wsDiv.addRow([label]);
    const crit = `${cRange('E')},"${label}",${cRange('P')},"${DIV_FOREIGN}"`;
    r.getCell('G').value = f(`COUNTIFS(${crit})`, ds.length);
    for (const [col, v] of [
      ['K', ds.reduce((a, d) => a + d.gross, 0)],
      ['L', ds.reduce((a, d) => a + d.withheld, 0)],
      ['N', ds.reduce((a, d) => a + d.credit, 0)],
      ['O', ds.reduce((a, d) => a + Math.max(0, d.treaty == null ? 0 : d.withheld - d.gross * d.treaty), 0)],
    ] as const) {
      r.getCell(col).value = f(`SUMIFS(${cRange(col)},${crit})`, v);
      r.getCell(col).numFmt = FMT_CZK;
    }
  }
  if (!countries.length) wsDiv.addRow(['žádné zahraniční dividendy']);

  // ---------- Úroky (§8 without final withholding) ----------
  const interest = ledger.cash
    .filter((c) => c.kind === 'INTEREST' && c.amount > 0 && c.broker !== 'XTB' && c.date.startsWith(`${year}-`))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  let intRange: { first: number; last: number } | null = null;
  const intCalc: number[] = [];
  if (interest.length) {
    const wsInt = wb.addWorksheet(SHEET_INT);
    title(wsInt, `Úroky bez srážkové daně v roce ${year}`, 'Příjmy z kapitálového majetku (§ 8) – uvádějí se na ř. 38 bez ohledu na volbu § 16a. Úroky z XTB jsou zdaněny srážkou u zdroje a nejsou zde uvedeny.');
    const start = wsInt.rowCount + 2;
    const rows = interest.map((c, i) => {
      const czk = fx.toCzkTax(c.amount, c.currency, c.date);
      const ri = rates.info(c.currency, c.date, c.amount, czk);
      intCalc.push(c.amount * ri.rate);
      return [c.broker, xDate(c.date), c.description, c.currency, c.amount, ri.rate, ri.source, f(`E${start + i}*F${start + i}`, c.amount * ri.rate)] as Cell[];
    });
    intRange = table(
      wsInt,
      [
        { header: 'Broker', width: 9 },
        { header: 'Datum', width: 11, fmt: FMT_DATE },
        { header: 'Popis', width: 40 },
        { header: 'Měna', width: 6 },
        { header: 'Částka (v měně)', width: 13, fmt: FMT_CZK },
        { header: 'Kurz', width: 10, fmt: FMT_RATE },
        { header: 'Zdroj kurzu', width: 18 },
        { header: 'Částka Kč', width: 13, fmt: FMT_CZK },
      ],
      rows,
    );
  }

  // ---------- Souhrn ----------
  wsSum.getColumn(1).width = 64;
  wsSum.getColumn(2).width = 18;
  wsSum.getColumn(3).width = 70;
  title(wsSum, `Podklady k daňovému přiznání za rok ${year}`, `Vygenerováno aplikací My finance ${new Date().toLocaleString('cs-CZ')}${s.demo ? ' – DEMO DATA (smyšlené portfolio)' : ''}`);
  const section = (text: string) => {
    wsSum.addRow([]);
    const r = wsSum.addRow([text]);
    r.font = { bold: true, size: 12 };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EAF6' } };
    r.getCell(2).fill = r.getCell(1).fill;
    r.getCell(3).fill = r.getCell(1).fill;
  };
  const line = (label: string, value: Cell, how = '', fmt = FMT_CZK, bold = false) => {
    const r = wsSum.addRow([label, value, how]);
    r.getCell(2).numFmt = fmt;
    r.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(3).font = { color: { argb: 'FF555555' } };
    if (bold) r.font = { bold: true };
    return `B${r.number}`;
  };

  section('Vstupy a nastavení výpočtu');
  line('Daňová situace', SITUATION_LABELS[profile.situation], '', '@');
  line('Přepočet cizích měn', fxLabel(fxMethod), 'Zvolený způsob platí pro všechny příjmy roku; nákupy z dřívějších let se přepočítávají způsobem zvoleným pro rok nákupu. Výjimka: obchody na účtu XTB vedeném v CZK se berou ve skutečně vypořádané částce v Kč (kurz brokera). Viz list Kurzy.', '@');
  if (year >= 2021) line('Zahraniční dividendy', use16a ? 'samostatný základ § 16a (Příloha č. 4)' : 'obecný základ (ř. 38 + Příloha č. 3)', '', '@');
  line('Jiný základ daně (z Nastavení)', profile.otherTaxBase ?? 0, 'Základ daně z ostatních příjmů (zaměstnání, podnikání) – ovlivňuje jen odhad daně a Přílohu č. 3.', FMT_KC);
  line('Zdrojové exporty', s.files.map((p) => basename(p)).join(', ') || '–', '', '@');

  // securities
  const S = (letter: string) => rng(SHEET_SALES, letter, sales.first, sales.last);
  const wCol = sales.col(23);
  const vCol = sales.col(22);
  const totalProceeds = salesCalc.reduce((a, x) => a + x.proceeds, 0);
  const ttProceeds = salesCalc.filter((x) => x.timeTest).reduce((a, x) => a + x.proceeds, 0);
  const limitProceeds = totalProceeds - ttProceeds;
  const taxableInc = salesCalc.filter((x) => x.cls === CLASS_TAXABLE).reduce((a, x) => a + x.proceeds, 0);
  const taxableExp = salesCalc.filter((x) => x.cls === CLASS_TAXABLE).reduce((a, x) => a + x.expenses, 0);
  section('Cenné papíry – ostatní příjmy (§ 10, Příloha č. 2)');
  line('Příjmy z prodeje CP celkem', f(`SUM(${S('P')})`, totalProceeds), `Součet sloupce „Příjem z prodeje Kč“ na listu ${SHEET_SALES}.`);
  line('z toho prodeje se splněným časovým testem', f(`SUMIFS(${S('P')},${S(vCol)},"ano")`, ttProceeds), 'Držení déle než 3 roky – osvobozeno podle § 4 odst. 1 písm. u) ZDP, do přiznání se neuvádí.');
  const limitRef = line('Příjmy bez časového testu (pro limit 100 000 Kč)', f(`SUMIFS(${S('P')},${S(vCol)},"ne")`, limitProceeds), 'Rozhoduje příjem (prodejní cena), ne zisk.');
  line(
    'Limit 100 000 Kč (§ 4 odst. 1 písm. t)',
    f(`IF(${limitRef}<=${SMALL_SALES_LIMIT},"nepřekročen – osvobozeno","překročen – zdanitelné")`, limitProceeds <= SMALL_SALES_LIMIT ? 'nepřekročen – osvobozeno' : 'překročen – zdanitelné'),
    'Pokud příjmy bez časového testu nepřesáhnou 100 000 Kč, jsou osvobozeny všechny.',
    '@',
  );
  const incRef = line('Zdanitelné příjmy', f(`SUMIFS(${S('P')},${S(wCol)},"${CLASS_TAXABLE}")`, taxableInc), `Řádky se zařazením „${CLASS_TAXABLE}“.`);
  const expRef = line('Výdaje k zdanitelným příjmům', f(`SUMIFS(${S('R')},${S(wCol)},"${CLASS_TAXABLE}")`, taxableExp), 'Nabývací cena + poplatky při nákupu i prodeji (§ 10 odst. 4 ZDP).');
  line('Výsledek (zisk − ztráta)', f(`${incRef}-${expRef}`, taxableInc - taxableExp), 'Ztráty se kompenzují jen se zisky z prodejů CP v témže roce.');
  const r207 = Math.round(taxableInc);
  const r208 = Math.round(Math.min(taxableExp, taxableInc));
  const ref207 = line('ř. 207 – příjmy podle § 10', f(`ROUND(${incRef},0)`, r207), 'Zaokrouhleno na celé Kč.', FMT_KC, true);
  const ref208 = line('ř. 208 – výdaje podle § 10', f(`ROUND(MIN(${expRef},${incRef}),0)`, r208), 'Výdaje nejvýše do výše příjmů – ztrátu nelze uplatnit.', FMT_KC, true);
  line('ř. 209 – dílčí základ daně § 10 (→ ř. 40)', f(`${ref207}-${ref208}`, r207 - r208), 'ř. 207 − ř. 208', FMT_KC, true);
  if (sec.capExcessCzk > 0)
    line('Pozor: limit 40 mil. Kč (2025)', sec.capExcessCzk, 'Osvobozené příjmy přesahují 40 mil. Kč – poměrná část se daní. Řádky 207–209 výše tento přesah nezahrnují; správné hodnoty jsou na listu DAP.', FMT_KC);

  // dividends
  const D = (letter: string) => rng(SHEET_DIV, letter, divT.first, divT.last);
  const foreign = divCalc.filter((d) => d.foreign);
  const fGross = foreign.reduce((a, d) => a + d.gross, 0);
  const fWith = foreign.reduce((a, d) => a + d.withheld, 0);
  const fCredit = foreign.reduce((a, d) => a + d.credit, 0);
  const fCreditedGross = foreign.filter((d) => d.credit > 0).reduce((a, d) => a + d.gross, 0);
  const cz = divCalc.filter((d) => !d.foreign);
  section('Dividendy a kapitálové příjmy (§ 8)');
  const grossRef = line('Zahraniční dividendy hrubě', f(`SUMIFS(${D('K')},${D('P')},"${DIV_FOREIGN}")`, fGross), `Součet „Hrubá dividenda Kč“ na listu ${SHEET_DIV} (zahraniční).`);
  line('Sražená daň v zahraničí', f(`SUMIFS(${D('L')},${D('P')},"${DIV_FOREIGN}")`, fWith));
  const creditRef = line('Započitatelná zahraniční daň', f(`SUMIFS(${D('N')},${D('P')},"${DIV_FOREIGN}")`, fCredit), 'U každé výplaty nejvýše hrubá dividenda × smluvní sazba.');
  line('České dividendy (zdaněny srážkou, nepřiznávají se)', f(`SUMIFS(${D('K')},${D('P')},"${DIV_CZ}")`, cz.reduce((a, d) => a + d.gross, 0)));
  if (intRange) {
    const total = intCalc.reduce((a, b) => a + b, 0);
    line('Úroky bez srážkové daně (ř. 38)', f(`SUM(${rng(SHEET_INT, 'H', intRange.first, intRange.last)})`, total), `List ${SHEET_INT}.`);
  }
  if (year >= 2021 && use16a && fGross > 0) {
    section('Příloha č. 4 – samostatný základ daně (§ 16a)');
    const r401a = Math.round(fGross);
    const r409 = Math.floor(r401a / 100) * 100;
    const r410 = Math.round(r409 * 0.15);
    const r411 = Math.round(fCreditedGross);
    const r412 = Math.round(fCredit);
    const r413 = Math.round(Math.min(r412, r411 * 0.15));
    const a = line('ř. 401a – příjmy podle § 8 ze zahraničí', f(`ROUND(${grossRef},0)`, r401a), 'Hrubé zahraniční dividendy.', FMT_KC, true);
    const b = line('ř. 406 – úhrn samostatných základů', f(a, r401a), 'ř. 401 + ř. 401a', FMT_KC);
    const c = line('ř. 409 – zaokrouhleno na celá sta Kč dolů', f(`ROUNDDOWN(${b}/100,0)*100`, r409), '', FMT_KC);
    const d = line('ř. 410 – daň 15 %', f(`ROUND(${c}*0.15,0)`, r410), 'ř. 409 × 15 %', FMT_KC);
    const e = line(
      'ř. 411 – příjmy, u nichž se uplatní zápočet',
      f(`ROUND(SUMIFS(${D('K')},${D('P')},"${DIV_FOREIGN}",${D('N')},">0"),0)`, r411),
      'Hrubé dividendy, z nichž byla sražena započitatelná daň.',
      FMT_KC,
    );
    const g = line('ř. 412 – daň zaplacená v zahraničí', f(`ROUND(${creditRef},0)`, r412), 'Nejvýše do smluvní sazby.', FMT_KC);
    const h = line('ř. 413 – daň uznaná k zápočtu', f(`ROUND(MIN(${g},${e}*0.15),0)`, r413), 'Nejvýše 15 % z ř. 411.', FMT_KC);
    line('ř. 414 – daň ze samostatného základu (→ ř. 74a)', f(`MAX(0,${d}-${h})`, Math.max(0, r410 - r413)), 'ř. 410 − ř. 413', FMT_KC, true);
  } else if (fGross > 0) {
    line('Zdanění v obecném základu', 'ř. 38 + Příloha č. 3', 'Zápočet zahraniční daně (Příloha č. 3) závisí na celkovém základu daně – hodnoty po státech jsou na listu DAP (odhad podle jiného základu daně z Nastavení).', '@');
  }

  section('Odhad daně (orientační, hodnoty z aplikace)');
  line(
    'Daň z prodeje CP',
    sum.estimatedTaxSecuritiesCzk,
    'O kolik se zvýší daň, když se k jinému základu daně z Nastavení přičte ř. 209 (sazba 15 %, nad limit 23 %). Nejde o řádek přiznání – celková daň závisí i na slevách a dalších příjmech.',
    FMT_KC,
  );
  line('Daň ze zahraničních dividend', sum.estimatedTaxDividendsCzk, use16a && year >= 2021 ? 'ř. 414 Přílohy č. 4' : 'po zápočtu podle Přílohy č. 3', FMT_KC);
  line('Odhad daně celkem', sum.estimatedTaxTotalCzk, '', FMT_KC, true);
  if (sum.filingReason) line('Povinnost podat přiznání', sum.mustFile ? 'ano' : 'ne', sum.filingReason, '@');
  for (const n of sum.notes.slice(1)) line('Upozornění', n.severity === 'info' ? 'info' : 'pozor', n.text, '@');

  section('Metodika');
  for (const t of [
    'Párování nákupů a prodejů metodou FIFO (první nakoupené = první prodané), samostatně pro každý účet u brokera. Splity a výměny akcií zachovávají původní datum a nabývací cenu nákupu.',
    'Časový test: prodej je osvobozen, pokud doba mezi nabytím a prodejem přesáhne 3 roky (§ 4 odst. 1 písm. u ZDP).',
    'Nabývací cena se přepočítává kurzem platným pro rok (den) nákupu, příjem z prodeje kurzem pro rok (den) prodeje – podle zvoleného způsobu přepočtu daného roku (§ 38 ZDP).',
    'Poplatky při nákupu a prodeji jsou součástí výdajů. Přepočítávají se stejně jako obchod, ke kterému patří (jednotným kurzem roku obchodu, nebo denním kurzem ke dni obchodu – podle zvoleného způsobu).',
    'Smluvní sazby pro zápočet zahraniční daně vycházejí ze smluv o zamezení dvojího zdanění (u dividend obvykle 15 %); v Nastavení je lze pro jednotlivé státy upravit.',
    'Všechny částky jsou podkladem, nikoli daňovým poradenstvím. Před podáním ověřte aktuální tiskopis a pokyny Finanční správy.',
  ]) {
    const r = wsSum.addRow([t]);
    r.getCell(1).alignment = { wrapText: true };
    wsSum.mergeCells(r.number, 1, r.number, 3);
  }

  // ---------- Kurzy ----------
  const wsFx = wb.addWorksheet('Kurzy');
  title(wsFx, 'Použité kurzy (Kč za 1 jednotku měny)', `Způsob přepočtu roku ${year}: ${fxLabel(fxMethod)}.`);
  const used = [...rates.used.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.kind.localeCompare(b.kind) || a.period.localeCompare(b.period));
  table(
    wsFx,
    [
      { header: 'Měna', width: 8 },
      { header: 'Druh kurzu', width: 24 },
      { header: 'Rok / datum', width: 12 },
      { header: 'Kurz', width: 12, fmt: FMT_RATE },
      { header: 'Zdroj', width: 80 },
    ],
    used.map((u) => [u.currency, u.kind, u.period, u.rate, u.source]),
  );
  if (!used.length) wsFx.addRow(['Všechny částky byly v CZK.']);

  // ---------- DAP ----------
  const wsDap = wb.addWorksheet('DAP');
  title(wsDap, `Hodnoty do daňového přiznání ${year}`, 'Stejné hodnoty jako v aplikaci (sekce Daně). Vzorce, kterými vznikly, jsou na listu Souhrn.');
  wsDap.getColumn(1).width = 12;
  wsDap.getColumn(2).width = 70;
  wsDap.getColumn(3).width = 16;
  wsDap.getColumn(4).width = 70;
  for (const b of dap.blocks) {
    wsDap.addRow([b.title]).font = { bold: true, size: 12 };
    if (b.description) {
      const r = wsDap.addRow([b.description]);
      wsDap.mergeCells(r.number, 1, r.number, 4);
      r.getCell(1).alignment = { wrapText: true };
      r.height = 45;
    }
    if (b.fields.length) {
      const h = wsDap.rowCount + 1;
      wsDap.addRow(['Řádek', 'Položka', 'Hodnota', 'Poznámka']);
      styleHeader(wsDap, h);
      for (const fl of b.fields) {
        const r = wsDap.addRow([fl.row, fl.label, fl.value, fl.note ?? '']);
        if (typeof fl.value === 'number') r.getCell(3).numFmt = Number.isInteger(fl.value) ? FMT_KC : '0.00';
        r.getCell(4).alignment = { wrapText: true };
      }
    }
    wsDap.addRow([]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
