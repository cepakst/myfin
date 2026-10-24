import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YahooFinance from 'yahoo-finance2';
import type { Instrument, Ledger, Trade } from '../core/types.js';
import { addDays, isoDateUtc, todayIso } from '../core/util.js';
import { CACHE_DIR, ensureDir } from './paths.js';

export interface PriceSeries {
  symbol: string;
  currency: string;
  /** ISO dates, ascending */
  dates: string[];
  /** Actual (not split-adjusted) close prices in `currency` */
  closes: number[];
  /** Splits: date + ratio (new shares per old share) */
  splits: { date: string; ratio: number }[];
  fetchedAt: number;
}

export interface SymbolInfo {
  symbol: string | null;
  source: 'override' | 'auto' | 'none' | 'disabled';
  checkedAt: number;
  note?: string;
}

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const PRICE_TTL_MS = 12 * 3600 * 1000;
const SYMBOL_RETRY_MS = 7 * 24 * 3600 * 1000;

const SUBUNIT: Record<string, [string, number]> = { GBP: ['GBP', 1], GBp: ['GBP', 100], GBX: ['GBP', 100], ILA: ['ILS', 100], ZAc: ['ZAR', 100] };

const DEGIRO_EXCHANGE_SUFFIX: Record<string, string[]> = {
  NDQ: [''], NSY: [''], NYSE: [''], NASDAQ: [''], ASE: [''], BATS: [''],
  XET: ['.DE', '.F'], FRA: ['.F', '.DE'], TDG: ['.DE', '.F'],
  EPA: ['.PA'], EAM: ['.AS'], EBR: ['.BR'], ELI: ['.LS'], MIL: ['.MI'], MAD: ['.MC'],
  LSE: ['.L'], OMX: ['.ST'], OMXH: ['.HE'], HSE: ['.HE'], CSE: ['.CO'], OSL: ['.OL'],
  SWX: ['.SW'], VTX: ['.SW'], TOR: ['.TO'], TSV: ['.V'], WSE: ['.WA'], PRA: ['.PR'],
  ASX: ['.AX'], HKS: ['.HK'], TSE: ['.T'], ATH: ['.AT'], ISE: ['.IR'], VIE: ['.VI'],
};

const XTB_SUFFIX: Record<string, string> = { UK: '.L', US: '', DE: '.DE', NL: '.AS', FR: '.PA', IT: '.MI', ES: '.MC', PL: '.WA', CZ: '.PR', CH: '.SW', DK: '.CO', SE: '.ST', NO: '.OL', FI: '.HE', BE: '.BR', PT: '.LS' };

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeName(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const CHART_START = '2000-01-01';

async function fetchChart(symbol: string, from: string): Promise<PriceSeries | null> {
  const r = (await yf.chart(symbol, { period1: from, interval: '1d', events: 'split' } as never)) as unknown as {
    meta: { currency?: string };
    quotes: { date: Date; close: number | null }[];
    events?: { splits?: { date: Date | string; numerator: number; denominator: number }[] };
  };
  const rawCur = r.meta.currency ?? 'USD';
  const [currency, div] = SUBUNIT[rawCur] ?? [rawCur.toUpperCase(), 1];
  const splits = (r.events?.splits ?? [])
    .map((s) => ({ date: isoDateUtc(new Date(s.date)), ratio: s.numerator / s.denominator }))
    .filter((s) => Number.isFinite(s.ratio) && s.ratio > 0 && s.ratio !== 1)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates: string[] = [];
  const closes: number[] = [];
  for (const q of r.quotes) {
    if (q.close == null || !Number.isFinite(q.close) || q.close <= 0) continue;
    const d = isoDateUtc(new Date(q.date));
    // undo split adjustment: price before a split was higher by the split ratio
    let f = 1;
    for (const s of splits) if (d < s.date) f *= s.ratio;
    if (dates.length && dates[dates.length - 1] === d) {
      closes[closes.length - 1] = (q.close * f) / div;
      continue;
    }
    dates.push(d);
    closes.push((q.close * f) / div);
  }
  if (!dates.length) return null;
  return { symbol, currency, dates, closes, splits, fetchedAt: Date.now() };
}

export function priceOn(s: PriceSeries, date: string): number | null {
  if (!s.dates.length || date < s.dates[0]) return null;
  let lo = 0;
  let hi = s.dates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.dates[mid] <= date) lo = mid;
    else hi = mid - 1;
  }
  return s.closes[lo];
}

export class MarketData {
  private symbolsFile: string;
  private symbols: Record<string, SymbolInfo>;
  private series = new Map<string, PriceSeries>();
  readonly errors: string[] = [];

  constructor(private log: (m: string) => void = () => {}) {
    ensureDir(join(CACHE_DIR, 'prices'));
    this.symbolsFile = join(CACHE_DIR, 'symbols.json');
    this.symbols = readJson(this.symbolsFile, {} as Record<string, SymbolInfo>);
  }

  symbolMap(): Record<string, SymbolInfo> {
    return this.symbols;
  }

  getSeries(instrumentId: string): PriceSeries | undefined {
    const sym = this.symbols[instrumentId]?.symbol;
    return sym ? this.series.get(sym) : undefined;
  }

  private async loadSeries(symbol: string, from: string, force = false): Promise<PriceSeries | null> {
    const file = join(CACHE_DIR, 'prices', `${safeName(symbol)}.json`);
    const cached = this.series.get(symbol) ?? readJson<PriceSeries | null>(file, null);
    if (cached && !force && Date.now() - cached.fetchedAt < PRICE_TTL_MS && cached.dates[0] <= addDays(from, 7)) {
      this.series.set(symbol, cached);
      return cached;
    }
    try {
      // fixed start date – never send the user's trade dates to the provider (AGENTS.md rule 3)
      const s = await fetchChart(symbol, from < CHART_START ? from.slice(0, 4) + '-01-01' : CHART_START);
      if (s) {
        writeFileSync(file, JSON.stringify(s));
        this.series.set(symbol, s);
        return s;
      }
    } catch (e) {
      this.errors.push(`${symbol}: ${(e as Error).message}`);
    }
    if (cached) this.series.set(symbol, cached);
    return cached;
  }

  private candidates(inst: Instrument, searchResults: string[]): string[] {
    const out: string[] = [];
    const push = (s: string) => {
      if (s && !out.includes(s)) out.push(s);
    };
    if (inst.id.startsWith('XTB:') || inst.brokerSymbol) {
      const t = inst.brokerSymbol ?? inst.id.slice(4);
      const m = /^(.+)\.([A-Z]{2})$/.exec(t);
      if (m) push(m[1] + (XTB_SUFFIX[m[2]] ?? `.${m[2]}`));
      else push(t);
    }
    const suffixes = inst.exchange ? DEGIRO_EXCHANGE_SUFFIX[inst.exchange] : undefined;
    if (suffixes) {
      for (const suf of suffixes)
        for (const s of searchResults) {
          const dot = s.lastIndexOf('.');
          const sSuf = dot > 0 ? s.slice(dot) : '';
          if (sSuf === suf) push(s);
        }
    }
    for (const s of searchResults) push(s);
    return out;
  }

  /**
   * Resolves a Yahoo symbol for the instrument and validates it against a reference trade:
   * the quote currency must match and the price must be within ±15 % of the traded price.
   */
  async resolve(inst: Instrument, ref: Trade | undefined, override: string | undefined, firstDate: string): Promise<SymbolInfo> {
    if (override !== undefined) {
      const info: SymbolInfo = { symbol: override || null, source: override ? 'override' : 'disabled', checkedAt: Date.now() };
      this.symbols[inst.id] = info;
      return info;
    }
    const prev = this.symbols[inst.id];
    if (prev && prev.source !== 'override' && prev.source !== 'disabled' && (prev.symbol || Date.now() - prev.checkedAt < SYMBOL_RETRY_MS)) return prev;

    const searchSyms: string[] = [];
    const cleanName = inst.name
      .replace(/\b(ADR ON|ADR|GDR|INC|CORP|CORPORATION|COMPANY|LIMITED|PLC|SA|AG|NV|SE|LTD|CLASS [A-Z]|AB|COMMON ST.*)\b\.?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 3)
      .join(' ');
    const queries = [inst.isin, inst.isin ? undefined : inst.brokerSymbol, cleanName].filter(Boolean) as string[];
    for (const q of queries) {
      try {
        const r = await yf.search(q, { quotesCount: 8, newsCount: 0 });
        for (const x of r.quotes as { symbol?: string; quoteType?: string }[])
          if (x.symbol && ['EQUITY', 'ETF', 'MUTUALFUND'].includes(x.quoteType ?? '')) searchSyms.push(x.symbol);
      } catch (e) {
        this.errors.push(`Hledání ${q}: ${(e as Error).message}`);
      }
      if (searchSyms.length >= 3) break;
    }
    let found: SymbolInfo = { symbol: null, source: 'none', checkedAt: Date.now(), note: 'Nenalezen ověřený symbol' };
    for (const sym of this.candidates(inst, searchSyms).slice(0, 6)) {
      const s = await this.loadSeries(sym, firstDate);
      if (!s) continue;
      if (!ref) {
        found = { symbol: sym, source: 'auto', checkedAt: Date.now(), note: 'Bez ověření cenou' };
        break;
      }
      const p = priceOn(s, ref.date);
      const refPrice = ref.price;
      if (s.currency !== ref.currency || p == null || refPrice <= 0) continue;
      const dev = Math.abs(p / refPrice - 1);
      if (dev <= 0.15) {
        found = { symbol: sym, source: 'auto', checkedAt: Date.now(), note: `Odchylka ${(dev * 100).toFixed(1)} %` };
        break;
      }
    }
    this.symbols[inst.id] = found;
    return found;
  }

  persist(): void {
    writeFileSync(this.symbolsFile, JSON.stringify(this.symbols, null, 1));
  }

  /** Resolves symbols and loads price history for every instrument in the ledger. */
  async loadAll(ledger: Ledger, overrides: Record<string, string>, opts: { force?: boolean } = {}): Promise<void> {
    const byInst = new Map<string, Trade[]>();
    for (const t of ledger.trades) {
      let l = byInst.get(t.instrumentId);
      if (!l) byInst.set(t.instrumentId, (l = []));
      l.push(t);
    }
    const firstSeen = new Map<string, string>();
    const see = (id: string, d: string) => {
      const p = firstSeen.get(id);
      if (!p || d < p) firstSeen.set(id, d);
    };
    for (const t of ledger.trades) see(t.instrumentId, t.date);
    for (const a of ledger.actions) see(a.kind === 'CONVERSION' ? a.toId : a.instrumentId, a.date);
    const insts = [...ledger.instruments.values()].filter((i) => i.type !== 'CFD');
    let done = 0;
    await pool(insts, 4, async (inst) => {
      const trades = byInst.get(inst.id) ?? [];
      const firstDate = addDays(firstSeen.get(inst.id) ?? todayIso(), -10);
      // reference = most recent trade with a price in the instrument currency
      const ref = [...trades].reverse().find((t) => t.price > 0);
      const info = await this.resolve(inst, ref, overrides[inst.id], firstDate);
      if (info.symbol) await this.loadSeries(info.symbol, firstDate, opts.force);
      if (++done % 20 === 0) this.log(`Tržní data: ${done}/${insts.length}`);
    });
    this.persist();
  }
}
