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
  missedTotalCzk: number;
  avoidedTotalCzk: number;
  avgHoldingDaysWinners: number | null;
  avgHoldingDaysLosers: number | null;
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

export function computeInsights(ledger: Ledger, econ: Realization[], dividends: DividendPayment[], prices: PriceProvider, dailyConv: Converter, today = todayIso()): Insights {
  const name = (id: string) => ledger.instruments.get(id)?.name ?? id;
  const byTrade = new Map<string, TradeResult & { cost: number }>();
  for (const r of econ) {
    let t = byTrade.get(r.tradeId);
    if (!t) byTrade.set(r.tradeId, (t = { tradeId: r.tradeId, instrumentId: r.instrumentId, name: name(r.instrumentId), sellDate: r.sellDate, qty: 0, proceedsCzk: 0, gainCzk: 0, gainPct: 0, holdingDays: 0, cost: 0 }));
    t.holdingDays = (t.holdingDays * t.qty + r.holdingDays * r.qty) / (t.qty + r.qty);
    t.qty += r.qty;
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
  for (const t of trades) {
    const v = yi(Number(t.sellDate.slice(0, 4)));
    if (t.gainCzk >= 0) {
      v.gainsCzk += t.gainCzk;
      wins.set(v.year, (wins.get(v.year) ?? 0) + 1);
    } else v.lossesCzk += -t.gainCzk;
  }
  const sellCounts = new Map<number, number>();
  for (const t of trades) sellCounts.set(Number(t.sellDate.slice(0, 4)), (sellCounts.get(Number(t.sellDate.slice(0, 4))) ?? 0) + 1);
  for (const t of ledger.trades) {
    const v = yi(Number(t.date.slice(0, 4)));
    v.trades++;
    v.volumeCzk += t.amountCzk ?? dailyConv(t.amount, t.currency, t.date);
    v.tradeFeesCzk += t.fees.reduce((s, f) => s + dailyConv(f.amount, f.currency, t.date), 0);
  }
  for (const c of ledger.cash) if (c.kind === 'FEE') yi(Number(c.date.slice(0, 4))).accountFeesCzk += -dailyConv(c.amount, c.currency, c.date);
  for (const v of years.values()) {
    v.eatenRatio = v.gainsCzk > 0 ? v.lossesCzk / v.gainsCzk : null;
    const n = sellCounts.get(v.year) ?? 0;
    v.winRate = n ? (wins.get(v.year) ?? 0) / n : null;
  }

  const missedMap = new Map<string, MissedItem>();
  for (const r of econ) {
    const f = followInstrument(ledger, r.instrumentId, r.qty, r.sellDate);
    const q = prices.price(f.id, today);
    if (!q || q.source !== 'market') continue;
    let m = missedMap.get(r.instrumentId);
    if (!m) missedMap.set(r.instrumentId, (m = { instrumentId: r.instrumentId, name: name(r.instrumentId), soldQty: 0, proceedsCzk: 0, valueTodayCzk: 0, diffCzk: 0, lastSellDate: r.sellDate }));
    m.soldQty += r.qty;
    m.proceedsCzk += r.proceedsCzk - r.sellFeesCzk;
    m.valueTodayCzk += f.qty * dailyConv(q.price, q.currency, today);
    if (r.sellDate > m.lastSellDate) m.lastSellDate = r.sellDate;
  }
  // instruments sold and later re-bought are still relevant – the comparison is "held instead of sold"
  const missed = [...missedMap.values()].map((m) => ({ ...m, diffCzk: m.valueTodayCzk - m.proceedsCzk })).sort((a, b) => b.diffCzk - a.diffCzk);

  const ys = [...years.values()].sort((a, b) => a.year - b.year);
  const sumY = (k: keyof YearInsight) => ys.reduce((s, y) => s + ((y[k] as number) ?? 0), 0);
  const gains = sumY('gainsCzk');
  const losses = sumY('lossesCzk');
  const volume = sumY('volumeCzk');
  const tradeFees = sumY('tradeFeesCzk');
  const winners = trades.filter((t) => t.gainCzk >= 0);
  const losers = trades.filter((t) => t.gainCzk < 0);
  const avg = (l: TradeResult[]) => (l.length ? l.reduce((s, t) => s + t.holdingDays, 0) / l.length : null);
  const sorted = [...trades].sort((a, b) => b.gainCzk - a.gainCzk);
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
    missedTotalCzk: missed.filter((m) => m.diffCzk > 0).reduce((s, m) => s + m.diffCzk, 0),
    avoidedTotalCzk: -missed.filter((m) => m.diffCzk < 0).reduce((s, m) => s + m.diffCzk, 0),
    avgHoldingDaysWinners: avg(winners),
    avgHoldingDaysLosers: avg(losers),
  };
}
