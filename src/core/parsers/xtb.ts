import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { CashEvent, CashKind, Instrument, Ledger } from '../types.js';
import { isoDateTimeUtc, parseNum } from '../util.js';

const BROKER = 'XTB' as const;

/** Known UCITS ETF tickers traded at XTB -> ISIN (used to merge with other brokers and to determine domicile). */
export const XTB_KNOWN_ISINS: Record<string, string> = {
  VUSA: 'IE00B3XXRP09',
  VUAA: 'IE00BFMXXD54',
  EUNL: 'IE00B4L5Y983',
  IWDA: 'IE00B4L5Y983',
  EUNK: 'IE00B4K48X80',
  EUNN: 'IE00B4L5YX21',
  CNYA: 'IE00BQT3WG13',
  IKOR: 'IE00B0M63391',
  IPRE: 'IE00B0M63284',
  CSPX: 'IE00B5BMR087',
  SXR8: 'IE00B5BMR087',
  EIMI: 'IE00BKM4GZ66',
  VWRA: 'IE00BK5BQT80',
  VWCE: 'IE00BK5BQT80',
  VWRL: 'IE00B3RBWM25',
  VWRD: 'IE00B3RBWM25',
};

/** XTB ticker suffix -> default trading currency */
const SUFFIX_CURRENCY: Record<string, string> = {
  US: 'USD',
  DE: 'EUR',
  FR: 'EUR',
  NL: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  BE: 'EUR',
  PT: 'EUR',
  FI: 'EUR',
  IE: 'EUR',
  UK: 'GBP',
  PL: 'PLN',
  CZ: 'CZK',
  CH: 'CHF',
  DK: 'DKK',
  SE: 'SEK',
  NO: 'NOK',
};

type Cell = ExcelJS.CellValue;

function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return cellText(v.result as Cell);
  }
  return String(v).trim();
}

function cellNum(v: Cell): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'result' in v) return cellNum(v.result as Cell);
  return parseNum(cellText(v));
}

function cellDate(v: Cell): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000));
  const s = cellText(v);
  if (!s) return null;
  const d = new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function sheetRows(ws: ExcelJS.Worksheet): Cell[][] {
  const out: Cell[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const vals = row.values as Cell[];
    out.push(Array.isArray(vals) ? vals.slice(1) : []);
  });
  return out;
}

function headerIndex(rows: Cell[][], required: string[]): { idx: number; cols: Map<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const texts = rows[i].map((c) => cellText(c).toLowerCase());
    if (required.every((r) => texts.includes(r.toLowerCase()))) {
      const cols = new Map<string, number>();
      texts.forEach((t, j) => cols.set(t, j));
      return { idx: i, cols };
    }
  }
  return null;
}

function tickerBase(ticker: string): { base: string; suffix: string } {
  const m = /^(.+?)\.([A-Z]{2})$/.exec(ticker.trim().toUpperCase());
  return m ? { base: m[1], suffix: m[2] } : { base: ticker.trim().toUpperCase(), suffix: '' };
}

export function xtbInstrumentId(ticker: string): string {
  const { base } = tickerBase(ticker);
  return XTB_KNOWN_ISINS[base] ?? `XTB:${ticker.trim().toUpperCase()}`;
}

function ensureInstrument(ledger: Ledger, ticker: string, name: string, category: string): string {
  const id = xtbInstrumentId(ticker);
  const { suffix } = tickerBase(ticker);
  const existing = ledger.instruments.get(id);
  if (existing) {
    if (!existing.brokerSymbol) existing.brokerSymbol = ticker;
    return id;
  }
  const isin = id.startsWith('XTB:') ? undefined : id;
  const cat = category.toUpperCase();
  const inst: Instrument = {
    id,
    isin,
    name: name || ticker,
    type: cat === 'ETF' ? 'ETF' : cat === 'CFD' ? 'CFD' : 'STOCK',
    currency: SUFFIX_CURRENCY[suffix] ?? 'EUR',
    brokerSymbol: ticker,
    country: isin ? isin.slice(0, 2) : cat === 'ETF' ? 'IE' : suffix === 'UK' ? 'GB' : suffix || undefined,
  };
  ledger.instruments.set(id, inst);
  return id;
}

const TRADE_RE = /(OPEN|CLOSE) (BUY|SELL)\s+(?:([A-Z0-9._-]+)\s+)?([\d.]+)(?:\/([\d.]+))?\s*@\s*([\d.]+)/i;

interface TypeRule {
  re: RegExp;
  kind: CashKind | 'BUY' | 'SELL' | 'IGNORE';
}

const TYPE_RULES: TypeRule[] = [
  { re: /^stock purchase$/i, kind: 'BUY' },
  { re: /^stock sale$/i, kind: 'SELL' },
  { re: /^divident?d?$/i, kind: 'DIVIDEND' },
  { re: /withholding tax/i, kind: 'DIVIDEND_TAX' },
  { re: /^free.?funds interest tax$/i, kind: 'INTEREST_TAX' },
  { re: /^free.?funds interest$/i, kind: 'INTEREST' },
  { re: /^deposit$/i, kind: 'DEPOSIT' },
  { re: /^(withdrawal|withdraw)$/i, kind: 'WITHDRAWAL' },
  { re: /(profit|close trade|swap|rollover)/i, kind: 'DERIVATIVE_PNL' },
  { re: /(commission|sec fee|fee)/i, kind: 'FEE' },
  { re: /^(total|transfer)$/i, kind: 'IGNORE' },
];

export async function loadXtbWorkbook(buf: Buffer | Uint8Array, fileName: string): Promise<{ name: string; data: Uint8Array }[]> {
  if (fileName.toLowerCase().endsWith('.zip')) {
    const zip = await JSZip.loadAsync(buf);
    const out: { name: string; data: Uint8Array }[] = [];
    for (const f of Object.values(zip.files)) {
      if (!f.dir && f.name.toLowerCase().endsWith('.xlsx')) out.push({ name: f.name, data: await f.async('uint8array') });
    }
    return out;
  }
  return [{ name: fileName, data: buf instanceof Uint8Array ? buf : new Uint8Array(buf) }];
}

export async function parseXtbXlsx(data: Uint8Array, ledger: Ledger, file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS typings expect a Node Buffer
  await wb.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  const accountCurrency = /^([A-Z]{3})_/.exec(file.split(/[\\/]/).pop() ?? '')?.[1] ?? 'CZK';

  const cashWs = wb.worksheets.find((w) => /cash operation/i.test(w.name));
  if (!cashWs) throw new Error(`${file}: chybí list "Cash Operations"`);
  const rows = sheetRows(cashWs);
  const hdr = headerIndex(rows, ['type', 'time', 'amount']);
  if (!hdr) throw new Error(`${file}: nerozpoznaná hlavička listu Cash Operations`);
  const c = (name: string) => hdr.cols.get(name) ?? -1;
  const iType = c('type');
  const iInstr = c('instrument');
  const iTicker = c('ticker') >= 0 ? c('ticker') : c('symbol');
  const iCat = c('category');
  const iTime = c('time');
  const iAmount = c('amount');
  const iId = c('id');
  const iComment = c('comment');

  let count = 0;
  for (let ri = hdr.idx + 1; ri < rows.length; ri++) {
    const r = rows[ri];
    const type = cellText(r[iType]);
    if (!type) continue;
    const rule = TYPE_RULES.find((x) => x.re.test(type));
    if (!rule) {
      ledger.warnings.push({ source: file, message: `Neznámý typ operace XTB: "${type}" (řádek ${ri + 1})` });
      continue;
    }
    if (rule.kind === 'IGNORE') continue;
    count++;
    const when = cellDate(r[iTime]);
    if (!when) {
      ledger.warnings.push({ source: file, message: `Chybí čas operace na řádku ${ri + 1}` });
      continue;
    }
    const dateTime = isoDateTimeUtc(when);
    const date = dateTime.slice(0, 10);
    const amount = cellNum(r[iAmount]);
    const ticker = iTicker >= 0 ? cellText(r[iTicker]) : '';
    const comment = iComment >= 0 ? cellText(r[iComment]) : '';
    const opId = iId >= 0 ? cellText(r[iId]) : String(ri);
    const instrumentId = ticker ? ensureInstrument(ledger, ticker, iInstr >= 0 ? cellText(r[iInstr]) : ticker, iCat >= 0 ? cellText(r[iCat]) : '') : undefined;

    if (rule.kind === 'BUY' || rule.kind === 'SELL') {
      const m = TRADE_RE.exec(comment);
      if (!m || !instrumentId) {
        ledger.warnings.push({ source: file, message: `Nelze rozpoznat obchod XTB: "${comment}" (řádek ${ri + 1})` });
        continue;
      }
      const qty = Number(m[4]);
      const price = Number(m[6]);
      const inst = ledger.instruments.get(instrumentId)!;
      ledger.trades.push({
        id: `XTB:${opId}`,
        broker: BROKER,
        instrumentId,
        dateTime,
        date,
        quantity: rule.kind === 'BUY' ? qty : -qty,
        price,
        currency: inst.currency,
        amount: qty * price,
        fees: [],
        amountCzk: accountCurrency === 'CZK' ? Math.abs(amount) : undefined,
        orderId: opId,
      });
      continue;
    }
    const ev: CashEvent = {
      id: `XTB:${opId}`,
      broker: BROKER,
      kind: rule.kind,
      dateTime,
      date,
      amount,
      currency: accountCurrency,
      instrumentId,
      description: comment || type,
      feeCategory: rule.kind === 'FEE' ? 'OTHER' : undefined,
    };
    ledger.cash.push(ev);
  }
  ledger.sources.push({ broker: BROKER, file, rows: count });

  // Open positions -> current broker valuation (used as fallback price source)
  const openWs = wb.worksheets.find((w) => /open position/i.test(w.name));
  if (openWs) {
    const orows = sheetRows(openWs);
    let asOf = '';
    for (const r of orows.slice(0, 6)) {
      const d = r.map(cellDate).find((x, j) => x && /as of|generated/i.test(cellText(r[j - 1] ?? '')));
      if (d) asOf = isoDateTimeUtc(d);
    }
    const oh = headerIndex(orows, ['ticker', 'volume', 'value']);
    if (oh) {
      const oc = (n: string) => oh.cols.get(n) ?? -1;
      const iT = oc('ticker');
      const iCat2 = oc('category');
      const iVol = oc('volume');
      const iVal = oc('value');
      const iCur = oc('current price');
      const iInst = oc('instrument/position');
      const lastPrice = new Map<string, number>();
      for (let ri = oh.idx + 1; ri < orows.length; ri++) {
        const r = orows[ri];
        const t = cellText(r[iT]);
        if (!t) continue;
        const p = cellNum(r[iCur]);
        if (Number.isFinite(p) && p > 0) lastPrice.set(t, p);
      }
      for (let ri = oh.idx + 1; ri < orows.length; ri++) {
        const r = orows[ri];
        const t = cellText(r[iT]);
        const cat = iCat2 >= 0 ? cellText(r[iCat2]) : '';
        if (!t || !cat) continue; // aggregate rows have a category
        const id = ensureInstrument(ledger, t, iInst >= 0 ? cellText(r[iInst]) : t, cat);
        ledger.brokerQuotes.set(id, {
          price: lastPrice.get(t) ?? NaN,
          quantity: cellNum(r[iVol]),
          valueCzk: accountCurrency === 'CZK' ? cellNum(r[iVal]) : undefined,
          asOf: asOf || new Date().toISOString().slice(0, 19),
        });
      }
    }
  }
}
