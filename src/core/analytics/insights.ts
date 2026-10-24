import type { Converter, Realization } from '../fifo.js';
import type { Ledger } from '../types.js';
import { todayIso } from '../util.js';
import type { DividendPayment } from '../tax/dividends.js';
import type { PriceProvider } from './prices.js';

export interface TradeResult {
  tradeId: string;
  instrumentId: string;
  name: string;
  sellDate: string;
  qty: number;
  proceedsCzk: number;
  gainCzk: number;
  gainPct: number;
  holdingDays: number;
}

export interface MissedItem {
  instrumentId: string;
  name: string;
  soldQty: number;
  proceedsCzk: number;
  valueTodayCzk: number;
  /** Positive = value lost by selling (stock rose since), negative = loss avoided */
  diffCzk: number;
  /** Net proceeds grown by the portfolio's time-weighted return from each sale until today (reinvestment estimate) */
  reinvestedValueCzk: number;
  /** valueTodayCzk − reinvestedValueCzk: missed potential after accounting for reinvestment of the proceeds */
  diffReinvestedCzk: number;
  lastSellDate: string;
}

export interface YearInsight {
  year: number;
  gainsCzk: number;
  lossesCzk: number;
  /** Share of realized gains eaten by realized losses */
  eatenRatio: number | null;
  tradeFeesCzk: number;
  accountFeesCzk: number;
  volumeCzk: number;
  trades: number;
  winRate: number | null;
}

export interface Insights {
  years: YearInsight[];
  total: { gainsCzk: number; lossesCzk: number; eatenRatio: number | null; tradeFeesCzk: number; accountFeesCzk: number; volumeCzk: number; feeToVolume: number | null; dividendsNetCzk: number; withholdingCzk: number };
  bestTrades: TradeResult[];
  worstTrades: TradeResult[];
  missed: MissedItem[];
  /** Sum of positive diffs (gross missed potential, no reinvestment) */
  missedTotalCzk: number;
  /** Sum of negative diffs as a positive number (losses avoided by selling) */
  avoidedTotalCzk: number;
  /** Net effect of all sales vs. holding (sum of diffCzk) */
  missedNetCzk: number;
  /** Net effect of all sales vs. holding when proceeds were reinvested in the portfolio (sum of diffReinvestedCzk) */
  missedNetReinvestedCzk: number;
  avgHoldingDaysWinners: number | null;
  avgHoldingDaysLosers: number | null;
}

export interface InsightsOptions {
  /** Restrict to a single calendar year (sales, trades, fees and dividends in that year); undefined = whole horizon */
  year?: number;
  /** Portfolio time-weighted return index on a date (see PerformanceResult.daily); enables the reinvestment estimate */
  twrAt?: (date: string) => number | undefined;
}

/** Follows splits and conversions after `date` so a sold quantity can be valued today. */
function followInstrument(ledger: Ledger, instrumentId: string, qty: number, date: string): { id: string; qty: number } {
  let id = instrumentId;
  let q = qty;
  const acts = [...ledger.actions].filter((a) => a.date > date).sort((a, b) => (a.dateTime < b.dateTime ? -1 : 1));
  for (const a of acts) {
    if (a.kind === 'SPLIT' && a.instrumentId === id) q *= a.ratio;
    else if (a.kind === 'CONVERSION' && a.fromId === id) {
      id = a.toId;
      q *= a.ratio;
    }
  }
  return { id, qty: q };
}

export function computeInsights(
  ledger: Ledger,
  econAll: Realization[],
  dividendsAll: DividendPayment[],
  prices: PriceProvider,
  dailyConv: Converter,
  today = todayIso(),
  opts: InsightsOptions = {},
): Insights {
  const inPeriod = (d: string) => opts.year == null || d.startsWith(`${opts.year}-`);
  const econ = econAll.filter((r) => inPeriod(r.sellDate));
  const dividends = dividendsAll.filter((d) => inPeriod(d.date));
  const name = (id: string) => ledger.instruments.get(id)?.name ?? id;

  const byTrade = new Map<string, TradeResult & { cost: number }>();
  for (const r of econ) {
    let t = byTrade.get(r.tradeId);
    if (!t) byTrade.set(r.tradeId, (t = { tradeId: r.tradeId, instrumentId: r.instrumentId, name: name(r.instrumentId), sellDate: r.sellDate, qty: 0, proceedsCzk: 0, gainCzk: 0, gainPct: 0, holdingDays: 0, cost: 0 }));
    // quantity-weighted holding period; rows with zero quantity (cash from corporate actions) must not produce NaN
    const q = t.qty + r.qty;
    if (q > 0) t.holdingDays = (t.holdingDays * t.qty + r.holdingDays * r.qty) / q;
    t.qty = q;
    t.proceedsCzk += r.proceedsCzk;
    t.gainCzk += r.gainCzk;
    t.cost += r.costCzk + r.buyFeesCzk;
  }
  const trades = [...byTrade.values()].map(({ cost, ...t }) => ({ ...t, gainPct: cost > 0 ? t.gainCzk / cost : 0 }));

  const years = new Map<number, YearInsight>();
  const yi = (y: number) => {
    let v = years.get(y);
    if (!v) years.set(y, (v = { year: y, gainsCzk: 0, lossesCzk: 0, eatenRatio: null, tradeFeesCzk: 0, accountFeesCzk: 0, volumeCzk: 0, trades: 0, winRate: null }));
    return v;
  };
  const wins = new Map<number, number>();
  const sellCounts = new Map<number, number>();
  for (const t of trades) {
    const y = Number(t.sellDate.slice(0, 4));
    const v = yi(y);
    sellCounts.set(y, (sellCounts.get(y) ?? 0) + 1);
    if (t.gainCzk >= 0) {
      v.gainsCzk += t.gainCzk;
      wins.set(y, (wins.get(y) ?? 0) + 1);
    } else v.lossesCzk += -t.gainCzk;
  }
  for (const t of ledger.trades) {
    if (!inPeriod(t.date)) continue;
    const v = yi(Number(t.date.slice(0, 4)));
    v.trades++;
    v.volumeCzk += t.amountCzk ?? dailyConv(t.amount, t.currency, t.date);
    v.tradeFeesCzk += t.fees.reduce((s, f) => s + dailyConv(f.amount, f.currency, t.date), 0);
  }
  for (const c of ledger.cash) if (c.kind === 'FEE' && inPeriod(c.date)) yi(Number(c.date.slice(0, 4))).accountFeesCzk += -dailyConv(c.amount, c.currency, c.date);
  for (const v of years.values()) {
    v.eatenRatio = v.gainsCzk > 0 ? v.lossesCzk / v.gainsCzk : null;
    const n = sellCounts.get(v.year) ?? 0;
    v.winRate = n ? (wins.get(v.year) ?? 0) / n : null;
  }

  const twrToday = opts.twrAt?.(today);
  const growth = (sellDate: string) => {
    const t0 = opts.twrAt?.(sellDate);
    return twrToday && t0 && t0 > 0 ? twrToday / t0 : 1;
  };
  const missedMap = new Map<string, Omit<MissedItem, 'diffCzk' | 'diffReinvestedCzk'>>();
  for (const r of econ) {
    const f = followInstrument(ledger, r.instrumentId, r.qty, r.sellDate);
    const q = prices.price(f.id, today);
    if (!q || q.source !== 'market') continue;
    let m = missedMap.get(r.instrumentId);
    if (!m) missedMap.set(r.instrumentId, (m = { instrumentId: r.instrumentId, name: name(r.instrumentId), soldQty: 0, proceedsCzk: 0, valueTodayCzk: 0, reinvestedValueCzk: 0, lastSellDate: r.sellDate }));
    const net = r.proceedsCzk - r.sellFeesCzk;
    m.soldQty += r.qty;
    m.proceedsCzk += net;
    m.valueTodayCzk += f.qty * dailyConv(q.price, q.currency, today);
    m.reinvestedValueCzk += net * growth(r.sellDate);
    if (r.sellDate > m.lastSellDate) m.lastSellDate = r.sellDate;
  }
  // instruments sold and later re-bought are still relevant – the comparison is "held instead of sold"
  const missed: MissedItem[] = [...missedMap.values()]
    .map((m) => ({ ...m, diffCzk: m.valueTodayCzk - m.proceedsCzk, diffReinvestedCzk: m.valueTodayCzk - m.reinvestedValueCzk }))
    .sort((a, b) => b.diffCzk - a.diffCzk);

  const ys = [...years.values()].sort((a, b) => a.year - b.year);
  const sumY = (k: keyof YearInsight) => ys.reduce((s, y) => s + ((y[k] as number) ?? 0), 0);
  const gains = sumY('gainsCzk');
  const losses = sumY('lossesCzk');
  const volume = sumY('volumeCzk');
  const tradeFees = sumY('tradeFeesCzk');
  const sold = trades.filter((t) => t.qty > 0);
  const avg = (l: TradeResult[]) => (l.length ? l.reduce((s, t) => s + t.holdingDays, 0) / l.length : null);
  const sorted = [...trades].sort((a, b) => b.gainCzk - a.gainCzk);
  const sumM = (f: (m: MissedItem) => number) => missed.reduce((s, m) => s + f(m), 0);
  return {
    years: ys,
    total: {
      gainsCzk: gains,
      lossesCzk: losses,
      eatenRatio: gains > 0 ? losses / gains : null,
      tradeFeesCzk: tradeFees,
      accountFeesCzk: sumY('accountFeesCzk'),
      volumeCzk: volume,
      feeToVolume: volume > 0 ? tradeFees / volume : null,
      dividendsNetCzk: dividends.reduce((s, d) => s + d.netCzkDaily, 0),
      withholdingCzk: dividends.reduce((s, d) => s + dailyConv(d.withheld, d.currency, d.date), 0),
    },
    bestTrades: sorted.slice(0, 10),
    worstTrades: sorted.slice(-10).reverse(),
    missed,
    missedTotalCzk: sumM((m) => Math.max(0, m.diffCzk)),
    avoidedTotalCzk: -sumM((m) => Math.min(0, m.diffCzk)),
    missedNetCzk: sumM((m) => m.diffCzk),
    missedNetReinvestedCzk: sumM((m) => m.diffReinvestedCzk),
    avgHoldingDaysWinners: avg(sold.filter((t) => t.gainCzk >= 0)),
    avgHoldingDaysLosers: avg(sold.filter((t) => t.gainCzk < 0)),
  };
}
