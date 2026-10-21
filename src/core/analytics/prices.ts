import type { Ledger } from '../types.js';

export interface SeriesLike {
  currency: string;
  dates: string[];
  closes: number[];
}

export interface PriceQuote {
  price: number;
  currency: string;
  date: string;
  source: 'market' | 'trade' | 'broker';
}

export interface PriceProvider {
  price(instrumentId: string, date: string): PriceQuote | null;
  hasMarket(instrumentId: string): boolean;
}

export function seriesIndex(dates: string[], date: string): number {
  if (!dates.length || date < dates[0]) return -1;
  let lo = 0;
  let hi = dates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (dates[mid] <= date) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface Point {
  date: string;
  price: number;
  currency: string;
  source: 'trade' | 'broker';
}

/** Market prices with fallback to the last traded (split-adjusted) price or the broker valuation. */
export function makePriceProvider(ledger: Ledger, series: Map<string, SeriesLike>): PriceProvider {
  const points = new Map<string, Point[]>();
  const splits = new Map<string, { date: string; ratio: number }[]>();
  const add = (id: string, p: Point) => {
    let l = points.get(id);
    if (!l) points.set(id, (l = []));
    l.push(p);
  };
  for (const t of ledger.trades) if (t.price > 0) add(t.instrumentId, { date: t.date, price: t.price, currency: t.currency, source: 'trade' });
  for (const a of ledger.actions) {
    if (a.kind !== 'SPLIT') continue;
    let l = splits.get(a.instrumentId);
    if (!l) splits.set(a.instrumentId, (l = []));
    l.push({ date: a.date, ratio: a.ratio });
  }
  for (const [id, q] of ledger.brokerQuotes) {
    if (q.valueCzk && q.quantity) add(id, { date: q.asOf.slice(0, 10), price: q.valueCzk / q.quantity, currency: 'CZK', source: 'broker' });
  }
  const pointDates = new Map<string, string[]>();
  for (const [id, l] of points) {
    l.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    pointDates.set(id, l.map((p) => p.date));
  }

  return {
    hasMarket: (id) => series.has(id),
    price(id, date) {
      const pts = points.get(id);
      const pi = pts ? seriesIndex(pointDates.get(id)!, date) : -1;
      const s = series.get(id);
      if (s) {
        const i = seriesIndex(s.dates, date);
        const seriesEnd = s.dates[s.dates.length - 1];
        // after the market series ends (delisting), a newer trade/broker point wins
        const newerPoint = pi >= 0 && pts![pi].date > seriesEnd;
        if (i >= 0 && !newerPoint) return { price: s.closes[i], currency: s.currency, date: s.dates[i], source: 'market' };
      }
      if (!pts?.length) return null;
      // before the first known price (e.g. free shares / rights) use the earliest point
      const p = pts[Math.max(0, pi)];
      let f = 1;
      for (const sp of splits.get(id) ?? []) if (sp.date > p.date && sp.date <= date) f *= sp.ratio;
      return { price: p.price / f, currency: p.currency, date: p.date, source: p.source };
    },
  };
}
