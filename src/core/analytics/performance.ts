import type { Converter, Realization } from '../fifo.js';
import type { Ledger } from '../types.js';
import { addDays, todayIso } from '../util.js';
import type { PriceProvider } from './prices.js';

export interface DailyPoint {
  date: string;
  value: number;
  /** Cumulative net invested capital (buys incl. fees − net sale proceeds) */
  invested: number;
  /** Cumulative income (net dividends, interest, other cash, minus account fees) */
  income: number;
  /** Time-weighted return index, starts at 1 */
  twr: number;
}

export interface YearPerformance {
  year: number;
  startValue: number;
  endValue: number;
  buys: number;
  sells: number;
  /** Absolute profit/loss of the year */
  pnl: number;
  twr: number;
  mwr: number | null;
  breakdown: {
    realized: number;
    unrealized: number;
    dividendsGross: number;
    withholdingTax: number;
    interest: number;
    otherIncome: number;
    tradeFees: number;
    accountFees: number;
  };
}

export interface PerformanceResult {
  daily: DailyPoint[];
  years: YearPerformance[];
  total: { pnl: number; twr: number; xirr: number | null; invested: number; value: number; income: number };
  missingPrices: string[];
}

interface DayFlows {
  buys: number;
  sells: number;
  income: number;
}

export function xirr(flows: { date: string; amount: number }[]): number | null {
  const fs = flows.filter((f) => Math.abs(f.amount) > 1e-6);
  if (fs.length < 2 || !fs.some((f) => f.amount > 0) || !fs.some((f) => f.amount < 0)) return null;
  const t0 = Date.parse(fs[0].date);
  const ts = fs.map((f) => (Date.parse(f.date) - t0) / (365 * 86400000));
  const npv = (r: number) => fs.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, ts[i]), 0);
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-6) return mid;
    if (fm * flo < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

export function computePerformance(
  ledger: Ledger,
  prices: PriceProvider,
  dailyConv: Converter,
  econRealizations: Realization[],
  endDate = todayIso(),
): PerformanceResult {
  const flows = new Map<string, DayFlows>();
  const fl = (d: string) => {
    let f = flows.get(d);
    if (!f) flows.set(d, (f = { buys: 0, sells: 0, income: 0 }));
    return f;
  };
  const yearAgg = new Map<number, YearPerformance['breakdown'] & { buys: number; sells: number }>();
  const ya = (d: string) => {
    const y = Number(d.slice(0, 4));
    let a = yearAgg.get(y);
    if (!a)
      yearAgg.set(
        y,
        (a = { realized: 0, unrealized: 0, dividendsGross: 0, withholdingTax: 0, interest: 0, otherIncome: 0, tradeFees: 0, accountFees: 0, buys: 0, sells: 0 }),
      );
    return a;
  };

  type QtyEv = { date: string; order: number; apply: (q: Map<string, number>) => void };
  const qtyEvents: QtyEv[] = [];

  for (const t of ledger.trades) {
    const gross = t.amountCzk ?? dailyConv(t.amount, t.currency, t.date);
    const fees = t.fees.reduce((s, f) => s + dailyConv(f.amount, f.currency, t.date), 0);
    const a = ya(t.date);
    a.tradeFees += fees;
    if (t.quantity > 0) {
      fl(t.date).buys += gross + fees;
      a.buys += gross + fees;
    } else {
      fl(t.date).sells += gross - fees;
      a.sells += gross - fees;
    }
    qtyEvents.push({ date: t.date, order: 1, apply: (q) => q.set(t.instrumentId, (q.get(t.instrumentId) ?? 0) + t.quantity) });
  }
  for (const act of ledger.actions) {
    if (act.kind === 'SPLIT') qtyEvents.push({ date: act.date, order: 0, apply: (q) => q.set(act.instrumentId, (q.get(act.instrumentId) ?? 0) * act.ratio) });
    else if (act.kind === 'CONVERSION')
      qtyEvents.push({
        date: act.date,
        order: 0,
        apply: (q) => {
          const v = q.get(act.fromId) ?? 0;
          q.set(act.fromId, 0);
          q.set(act.toId, (q.get(act.toId) ?? 0) + v * act.ratio);
        },
      });
    else qtyEvents.push({ date: act.date, order: 0, apply: (q) => q.set(act.instrumentId, (q.get(act.instrumentId) ?? 0) + act.quantity) });
  }
  qtyEvents.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  for (const c of ledger.cash) {
    if (c.kind === 'DEPOSIT' || c.kind === 'WITHDRAWAL') continue;
    const czk = dailyConv(c.amount, c.currency, c.date);
    fl(c.date).income += czk;
    const a = ya(c.date);
    switch (c.kind) {
      case 'DIVIDEND':
      case 'CAPITAL_RETURN':
        a.dividendsGross += czk;
        break;
      case 'DIVIDEND_TAX':
        a.withholdingTax += -czk;
        break;
      case 'INTEREST':
      case 'INTEREST_TAX':
        a.interest += czk;
        break;
      case 'FEE':
        a.accountFees += -czk;
        break;
      default:
        a.otherIncome += czk;
    }
  }
  for (const r of econRealizations) ya(r.sellDate).realized += r.proceedsCzk - r.costCzk;

  const firstDate = [...flows.keys(), ...qtyEvents.map((e) => e.date)].sort()[0];
  if (!firstDate) return { daily: [], years: [], total: { pnl: 0, twr: 0, xirr: null, invested: 0, value: 0, income: 0 }, missingPrices: [] };

  const qty = new Map<string, number>();
  const missing = new Set<string>();
  const daily: DailyPoint[] = [];
  let ei = 0;
  let prevValue = 0;
  let twr = 1;
  let invested = 0;
  let income = 0;
  for (let d = firstDate; d <= endDate; d = addDays(d, 1)) {
    while (ei < qtyEvents.length && qtyEvents[ei].date <= d) qtyEvents[ei++].apply(qty);
    let value = 0;
    for (const [id, q] of qty) {
      if (Math.abs(q) < 1e-9) continue;
      const p = prices.price(id, d);
      if (!p) {
        missing.add(id);
        continue;
      }
      value += q * dailyConv(p.price, p.currency, d);
    }
    const f = flows.get(d) ?? { buys: 0, sells: 0, income: 0 };
    const denom = prevValue + f.buys;
    if (denom > 1e-6) twr *= (value + f.sells + f.income) / denom;
    invested += f.buys - f.sells;
    income += f.income;
    daily.push({ date: d, value, invested, income, twr });
    prevValue = value;
  }

  const years: YearPerformance[] = [];
  const byYear = new Map<number, DailyPoint[]>();
  for (const p of daily) {
    const y = Number(p.date.slice(0, 4));
    let l = byYear.get(y);
    if (!l) byYear.set(y, (l = []));
    l.push(p);
  }
  let prevEnd: DailyPoint | null = null;
  for (const [year, pts] of [...byYear].sort((a, b) => a[0] - b[0])) {
    const last = pts[pts.length - 1];
    const startValue = prevEnd?.value ?? 0;
    const startTwr = prevEnd?.twr ?? 1;
    const a = ya(`${year}-01-01`);
    const totalIncome = a.dividendsGross - a.withholdingTax + a.interest + a.otherIncome - a.accountFees;
    const pnl = last.value - startValue - a.buys + a.sells + totalIncome;
    const unrealized = pnl - (a.realized + a.dividendsGross - a.withholdingTax + a.interest + a.otherIncome - a.tradeFees - a.accountFees);
    const cf: { date: string; amount: number }[] = [];
    if (startValue > 0) cf.push({ date: `${year}-01-01`, amount: -startValue });
    for (const p of pts) {
      const f = flows.get(p.date);
      if (f) cf.push({ date: p.date, amount: f.sells + f.income - f.buys });
    }
    cf.push({ date: last.date, amount: last.value });
    years.push({
      year,
      startValue,
      endValue: last.value,
      buys: a.buys,
      sells: a.sells,
      pnl,
      twr: last.twr / startTwr - 1,
      mwr: xirr(cf),
      breakdown: { ...a, unrealized },
    });
    prevEnd = last;
  }

  const last = daily[daily.length - 1];
  const allFlows = [...flows].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, f]) => ({ date, amount: f.sells + f.income - f.buys }));
  allFlows.push({ date: last.date, amount: last.value });
  return {
    daily,
    years,
    total: { pnl: last.value - last.invested + last.income, twr: last.twr - 1, xirr: xirr(allFlows), invested: last.invested, value: last.value, income: last.income },
    missingPrices: [...missing],
  };
}
