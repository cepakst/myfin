/**
 * Generates the bundled demo exports in demo/ (Degiro Transactions.csv + Account.csv, XTB CZK account .xlsx).
 *
 * The portfolio is fictitious, but uses real instruments with real historical prices, dividends and splits
 * (Yahoo Finance), so every screen of the app shows plausible numbers. Randomness is seeded – re-running the
 * script with the same end date produces the same trades (apart from revisions of the market data).
 *
 * Usage: npx tsx scripts/generate-demo.ts [YYYY-MM-DD end date, default today]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import YahooFinance from 'yahoo-finance2';

const START = '2023-01-01';
const END = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const OUT = resolve('demo');
const XTB_ACCOUNT = '50123456';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ---------- helpers ----------

let seed = 20230101;
function rnd(): number {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a: number, b: number) => a + (b - a) * rnd();
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000));
const dmy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const hhmm = (fromH: number, toH: number) => {
  const m = Math.floor(between(fromH * 60, toH * 60));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
const monthly = (fromMonth: string, day: number) => {
  const out: string[] = [];
  for (let d = new Date(fromMonth + '-01T00:00:00Z'); ; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const s = `${iso(d).slice(0, 8)}${String(day).padStart(2, '0')}`;
    if (s > END) return out;
    out.push(s);
  }
};

interface Series {
  dates: string[];
  closes: number[];
  divs: { date: string; amount: number }[];
  splits: { date: string; ratio: number }[];
}

async function load(symbol: string): Promise<Series> {
  const r = (await yf.chart(symbol, { period1: START, interval: '1d', events: 'div|split' } as never)) as unknown as {
    quotes: { date: Date; close: number | null }[];
    events?: { dividends?: { date: Date; amount: number }[]; splits?: { date: Date; numerator: number; denominator: number }[] };
  };
  const splits = (r.events?.splits ?? []).map((s) => ({ date: iso(s.date), ratio: s.numerator / s.denominator }));
  // Yahoo adjusts history for splits; exports contain the actual prices and per-share dividends
  const factor = (d: string) => splits.reduce((f, s) => (d < s.date ? f * s.ratio : f), 1);
  const dates: string[] = [];
  const closes: number[] = [];
  for (const q of r.quotes) {
    if (!q.close || q.close <= 0) continue;
    const d = iso(q.date);
    if (d > END) break;
    if (dates.at(-1) === d) closes[closes.length - 1] = q.close * factor(d);
    else {
      dates.push(d);
      closes.push(q.close * factor(d));
    }
  }
  const divs = (r.events?.dividends ?? []).map((x) => ({ date: iso(x.date), amount: x.amount * factor(iso(x.date)) })).filter((x) => x.date <= END);
  return { dates, closes, divs, splits: splits.filter((s) => s.date <= END) };
}

/** First trading day on or after `d` (null when after the end of the data) */
function tradingDay(s: Series, d: string): string | null {
  return s.dates.find((x) => x >= d) ?? null;
}
function closeOn(s: Series, d: string): number {
  let v = s.closes[0];
  for (let i = 0; i < s.dates.length && s.dates[i] <= d; i++) v = s.closes[i];
  return v;
}

// ---------- instruments ----------

interface Inst {
  yahoo: string;
  name: string;
  currency: 'USD' | 'EUR' | 'CZK';
  /** dividend withholding tax rate */
  wht: number;
  /** days between ex-date and payment */
  payLag: number;
  isin?: string;
  exchange?: string;
  venue?: string;
  fee?: number;
  xtbTicker?: string;
  xtbCategory?: 'STOCK' | 'ETF';
}

const DEGIRO: Record<string, Inst> = {
  AAPL: { yahoo: 'AAPL', name: 'APPLE INC. - COMMON ST', isin: 'US0378331005', exchange: 'NDQ', venue: 'XNAS', currency: 'USD', wht: 0.15, payLag: 3 },
  MSFT: { yahoo: 'MSFT', name: 'MICROSOFT CORPORATION', isin: 'US5949181045', exchange: 'NDQ', venue: 'XNAS', currency: 'USD', wht: 0.15, payLag: 28 },
  NVDA: { yahoo: 'NVDA', name: 'NVIDIA CORPORATION - C', isin: 'US67066G1040', exchange: 'NDQ', venue: 'XNAS', currency: 'USD', wht: 0.15, payLag: 7 },
  KO: { yahoo: 'KO', name: 'COCA-COLA COMPANY (THE', isin: 'US1912161007', exchange: 'NSY', venue: 'XNYS', currency: 'USD', wht: 0.15, payLag: 16 },
  JNJ: { yahoo: 'JNJ', name: 'JOHNSON & JOHNSON', isin: 'US4781601046', exchange: 'NSY', venue: 'XNYS', currency: 'USD', wht: 0.15, payLag: 18 },
  INTC: { yahoo: 'INTC', name: 'INTEL CORPORATION - CO', isin: 'US4581401001', exchange: 'NDQ', venue: 'XNAS', currency: 'USD', wht: 0.15, payLag: 14 },
  TSLA: { yahoo: 'TSLA', name: 'TESLA INC. - COMMON ST', isin: 'US88160R1014', exchange: 'NDQ', venue: 'XNAS', currency: 'USD', wht: 0.15, payLag: 14 },
  ALV: { yahoo: 'ALV.DE', name: 'ALLIANZ SE', isin: 'DE0008404005', exchange: 'XET', venue: 'XETA', currency: 'EUR', wht: 0.26375, payLag: 2 },
  ASML: { yahoo: 'ASML.AS', name: 'ASML HOLDING', isin: 'NL0010273215', exchange: 'EAM', venue: 'XAMS', currency: 'EUR', wht: 0.15, payLag: 4 },
  VWCE: { yahoo: 'VWCE.DE', name: 'VANGUARD FTSE ALL-WORLD UCITS ETF USD ACC', isin: 'IE00BK5BQT80', exchange: 'XET', venue: 'XETA', currency: 'EUR', wht: 0, payLag: 0, fee: 1 },
};

const XTB: Record<string, Inst> = {
  CEZ: { yahoo: 'CEZ.PR', name: 'CEZ', xtbTicker: 'CEZ.CZ', xtbCategory: 'STOCK', currency: 'CZK', wht: 0.15, payLag: 30 },
  KOMB: { yahoo: 'KOMB.PR', name: 'Komercni Banka', xtbTicker: 'KOMB.CZ', xtbCategory: 'STOCK', currency: 'CZK', wht: 0.15, payLag: 21 },
  AMZN: { yahoo: 'AMZN', name: 'Amazon.com Inc', xtbTicker: 'AMZN.US', xtbCategory: 'STOCK', currency: 'USD', wht: 0.15, payLag: 14 },
  SXR8: { yahoo: 'SXR8.DE', name: 'iShares Core S&P 500 UCITS ETF USD (Acc)', xtbTicker: 'SXR8.DE', xtbCategory: 'ETF', currency: 'EUR', wht: 0, payLag: 0 },
  VWCE: { yahoo: 'VWCE.DE', name: 'Vanguard FTSE All-World UCITS ETF USD Acc', xtbTicker: 'VWCE.DE', xtbCategory: 'ETF', currency: 'EUR', wht: 0, payLag: 0 },
};

// ---------- the story ----------

type Plan = { broker: 'DEGIRO' | 'XTB'; key: string; date: string } & ({ buy: number } | { buyQty: number } | { sellQty: number } | { sellAll: true });

const plans: Plan[] = [
  // Degiro: amounts in EUR
  { broker: 'DEGIRO', key: 'AAPL', date: '2023-01-10', buy: 1500 },
  { broker: 'DEGIRO', key: 'MSFT', date: '2023-01-10', buy: 1500 },
  { broker: 'DEGIRO', key: 'KO', date: '2023-02-15', buy: 1000 },
  { broker: 'DEGIRO', key: 'ALV', date: '2023-03-20', buy: 1200 },
  { broker: 'DEGIRO', key: 'INTC', date: '2023-04-12', buy: 1000 },
  { broker: 'DEGIRO', key: 'NVDA', date: '2023-05-18', buy: 1200 },
  { broker: 'DEGIRO', key: 'ASML', date: '2023-06-14', buy: 1300 },
  { broker: 'DEGIRO', key: 'JNJ', date: '2023-07-11', buy: 1000 },
  { broker: 'DEGIRO', key: 'TSLA', date: '2023-09-20', buy: 1000 },
  { broker: 'DEGIRO', key: 'MSFT', date: '2024-03-12', buyQty: 2 },
  { broker: 'DEGIRO', key: 'NVDA', date: '2024-07-22', sellQty: 20 },
  { broker: 'DEGIRO', key: 'INTC', date: '2024-11-15', sellAll: true }, // realised loss
  { broker: 'DEGIRO', key: 'TSLA', date: '2024-12-17', sellQty: 2 },
  { broker: 'DEGIRO', key: 'AAPL', date: '2025-04-08', buy: 800 },
  { broker: 'DEGIRO', key: 'ASML', date: '2025-04-08', buyQty: 1 },
  { broker: 'DEGIRO', key: 'JNJ', date: '2025-09-16', sellAll: true },
  { broker: 'DEGIRO', key: 'AAPL', date: '2026-02-10', sellQty: 5 }, // first lot, past the 3-year time test
  { broker: 'DEGIRO', key: 'KO', date: '2026-03-02', sellAll: true }, // past the time test
  { broker: 'DEGIRO', key: 'ALV', date: '2026-06-15', sellQty: 2 },
  ...monthly('2023-02', 10).map((date): Plan => ({ broker: 'DEGIRO', key: 'VWCE', date, buy: 600 })),
  // XTB: amounts in CZK
  { broker: 'XTB', key: 'CEZ', date: '2023-03-06', buyQty: 30 },
  { broker: 'XTB', key: 'KOMB', date: '2023-05-15', buyQty: 20 },
  { broker: 'XTB', key: 'AMZN', date: '2024-01-17', buyQty: 5 },
  { broker: 'XTB', key: 'AMZN', date: '2025-07-21', sellQty: 3 },
  { broker: 'XTB', key: 'CEZ', date: '2026-05-12', sellQty: 15 }, // past the time test
  ...monthly('2023-04', 3).flatMap((date): Plan[] => [
    { broker: 'XTB', key: 'SXR8', date, buy: 3000 },
    { broker: 'XTB', key: 'VWCE', date, buy: 2000 },
  ]),
];

const degiroDeposits = [{ date: '2023-01-05', amount: 9000 }, ...monthly('2023-02', 5).map((date) => ({ date, amount: 700 }))];
const xtbDeposits = [{ date: '2023-03-01', amount: 60000 }, ...monthly('2023-04', 2).map((date) => ({ date, amount: 5000 }))];
const xtbInterestRate = (year: number) => ({ 2023: 0.04, 2024: 0.035, 2025: 0.025 })[year] ?? 0.02;

// ---------- simulation ----------

interface DegiroTx {
  date: string;
  time: string;
  inst: Inst;
  qty: number;
  price: number;
  local: number;
  valueEur: number;
  rate: number | null;
  autoFx: number;
  fee: number;
  orderId: string;
}
interface DegiroAcc {
  date: string;
  time: string;
  valueDate: string;
  product: string;
  isin: string;
  desc: string;
  fx: number | null;
  currency: string;
  change: number;
  orderId: string;
}
interface XtbRow {
  type: string;
  inst?: Inst;
  time: Date;
  amount: number;
  comment: string;
}

async function main() {
  const series = new Map<string, Series>();
  const symbols = new Set([...Object.values(DEGIRO), ...Object.values(XTB)].map((i) => i.yahoo).concat(['EURUSD=X', 'EURCZK=X', 'CZK=X']));
  for (const s of symbols) {
    series.set(s, await load(s));
    process.stdout.write('.');
  }
  console.log();
  const S = (i: Inst) => series.get(i.yahoo)!;
  const eurusd = series.get('EURUSD=X')!;
  const eurczk = series.get('EURCZK=X')!;
  const usdczk = series.get('CZK=X')!;
  const czkPer = (cur: string, d: string) => (cur === 'CZK' ? 1 : cur === 'EUR' ? closeOn(eurczk, d) : closeOn(usdczk, d));

  const dTx: DegiroTx[] = [];
  const dAcc: DegiroAcc[] = [];
  const xRows: XtbRow[] = [];
  const hold = new Map<string, number>(); // `${broker}:${key}` -> quantity
  const trades: { broker: string; key: string; date: string; qty: number }[] = [];

  const accFx = (date: string, time: string, product: string, isin: string, usd: number, rate: number, orderId = '') => {
    // AutoFX: USD movements are immediately converted from / to EUR
    dAcc.push({ date, time, valueDate: date, product, isin, desc: usd < 0 ? 'FX Credit' : 'FX Debit', fx: rate, currency: 'USD', change: -usd, orderId });
    dAcc.push({ date, time, valueDate: date, product, isin, desc: usd < 0 ? 'FX Debit' : 'FX Credit', fx: rate, currency: 'EUR', change: round(usd / rate), orderId });
  };

  // Degiro stock split rows (NVIDIA 10:1 in June 2024)
  type Ev = { date: string; order: number; run: () => void };
  const events: Ev[] = [];
  for (const [key, inst] of Object.entries(DEGIRO))
    for (const sp of S(inst).splits)
      events.push({
        date: sp.date,
        order: 0,
        run: () => {
          const h = hold.get(`DEGIRO:${key}`) ?? 0;
          if (h <= 0) return;
          const p = closeOn(S(inst), addDays(sp.date, -1));
          const time = '07:12';
          const rate = round(closeOn(eurusd, sp.date), 4);
          const local = round(h * p);
          dTx.push({ date: sp.date, time, inst, qty: -h, price: round(p), local, valueEur: round(local / rate), rate, autoFx: 0, fee: 0, orderId: '' });
          dTx.push({ date: sp.date, time, inst, qty: h * sp.ratio, price: round(p / sp.ratio, 4), local: -local, valueEur: -round(local / rate), rate, autoFx: 0, fee: 0, orderId: '' });
          hold.set(`DEGIRO:${key}`, h * sp.ratio);
        },
      });

  for (const p of plans) {
    events.push({
      date: p.date,
      order: 1,
      run: () => {
        const inst = (p.broker === 'DEGIRO' ? DEGIRO : XTB)[p.key];
        const s = S(inst);
        const date = tradingDay(s, p.date);
        if (!date || date > END) return;
        const hk = `${p.broker}:${p.key}`;
        const held = hold.get(hk) ?? 0;
        const usEx = inst.currency === 'USD';
        const time = usEx ? hhmm(15.5, 21.5) : hhmm(9.1, 17.3);
        const price = round(closeOn(s, date) * between(0.992, 1.008), inst.currency === 'CZK' ? 1 : 2);
        const xtbFrac = p.broker === 'XTB' && inst.xtbCategory === 'ETF';
        let qty: number;
        if ('buy' in p) {
          const perUnit = p.broker === 'DEGIRO' ? price / (usEx ? closeOn(eurusd, date) : 1) : price * czkPer(inst.currency, date) * 1.005;
          qty = xtbFrac ? round(p.buy / perUnit, 4) : Math.max(1, Math.floor(p.buy / perUnit));
        } else if ('buyQty' in p) qty = p.buyQty;
        else if ('sellQty' in p) qty = -Math.min(p.sellQty, held);
        else qty = -held;
        if (qty === 0) return;
        hold.set(hk, round(held + qty, 4));
        trades.push({ broker: p.broker, key: p.key, date, qty });

        if (p.broker === 'DEGIRO') {
          const orderId = uuid();
          const rate = usEx ? round(closeOn(eurusd, date), 4) : null;
          const local = round(-qty * price);
          const valueEur = round(rate ? local / rate : local);
          const autoFx = rate ? -round(Math.abs(valueEur) * 0.0025) : 0;
          const fee = -(inst.fee ?? 2);
          dTx.push({ date, time, inst, qty, price, local, valueEur, rate, autoFx, fee, orderId });
          const side = qty > 0 ? 'Buy' : 'Sell';
          dAcc.push({ date, time, valueDate: date, product: inst.name, isin: inst.isin!, desc: 'DEGIRO Transaction and/or third party fees', fx: null, currency: 'EUR', change: fee, orderId });
          dAcc.push({ date, time, valueDate: date, product: inst.name, isin: inst.isin!, desc: `${side} ${Math.abs(qty)} ${inst.name}@${price} ${inst.currency} (${inst.isin})`, fx: null, currency: inst.currency, change: local, orderId });
          if (rate) accFx(date, time, inst.name, inst.isin!, local, rate, orderId);
        } else {
          const fxRate = czkPer(inst.currency, date);
          const czk = round(-qty * price * fxRate * (inst.currency === 'CZK' ? 1 : qty > 0 ? 1.005 : 0.995));
          const [hh, mm] = (inst.currency === 'CZK' ? hhmm(9, 16) : time).split(':').map(Number);
          xRows.push({
            type: qty > 0 ? 'Stock purchase' : 'Stock sale',
            inst,
            time: new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh - 1, mm, Math.floor(rnd() * 60))),
            amount: czk,
            comment: qty > 0 ? `OPEN BUY ${qty} @ ${price}` : `CLOSE BUY ${-qty}/${held} @ ${price}`,
          });
        }
      },
    });
  }

  // dividends: holdings at the ex-date (trades strictly before it)
  const splitAdjustedHeld = (broker: string, key: string, d: string) => {
    // trades keep their original quantities; apply splits between the trade and d
    let q = 0;
    const inst = (broker === 'DEGIRO' ? DEGIRO : XTB)[key];
    for (const t of trades) {
      if (t.broker !== broker || t.key !== key || t.date >= d) continue;
      let f = 1;
      for (const sp of S(inst).splits) if (t.date < sp.date && sp.date <= d) f *= sp.ratio;
      q += t.qty * f;
    }
    return q;
  };
  for (const [broker, set] of [['DEGIRO', DEGIRO], ['XTB', XTB]] as const)
    for (const [key, inst] of Object.entries(set))
      for (const dv of S(inst).divs) {
        const pay = addDays(dv.date, inst.payLag);
        if (pay > END) continue;
        events.push({
          date: pay,
          order: 2,
          run: () => {
            const q = splitAdjustedHeld(broker, key, dv.date);
            const gross = round(q * dv.amount);
            if (q <= 0 || gross < 0.01) return;
            const tax = round(gross * inst.wht);
            if (broker === 'DEGIRO') {
              const date = addDays(pay, 1);
              const time = hhmm(6, 9);
              dAcc.push({ date, time, valueDate: pay, product: inst.name, isin: inst.isin!, desc: 'Dividend', fx: null, currency: inst.currency, change: gross, orderId: '' });
              if (tax > 0) dAcc.push({ date, time, valueDate: pay, product: inst.name, isin: inst.isin!, desc: 'Dividend Tax', fx: null, currency: inst.currency, change: -tax, orderId: '' });
              if (inst.currency === 'USD') accFx(date, time, inst.name, inst.isin!, round(gross - tax), round(closeOn(eurusd, pay), 4));
            } else {
              const fx = czkPer(inst.currency, pay);
              const czk = round(gross * fx);
              const time = new Date(Date.parse(pay + 'T00:00:00Z') + between(6, 12) * 3600000);
              const per = `${inst.xtbTicker} ${inst.currency} ${dv.amount.toFixed(4)}/ SHR`;
              xRows.push({ type: 'DIVIDENT', inst, time, amount: czk, comment: per });
              if (tax > 0) xRows.push({ type: 'Withholding Tax', inst, time, amount: -round(czk * inst.wht), comment: `${inst.xtbTicker} ${inst.currency} WHT ${Math.round(inst.wht * 100)}%` });
            }
          },
        });
      }

  for (const d of degiroDeposits)
    events.push({
      date: d.date,
      order: -1,
      run: () => dAcc.push({ date: d.date, time: hhmm(8, 18), valueDate: d.date, product: '', isin: '', desc: 'flatex Deposit', fx: null, currency: 'EUR', change: d.amount, orderId: '' }),
    });
  for (const d of xtbDeposits)
    events.push({
      date: d.date,
      order: -1,
      run: () => xRows.push({ type: 'Deposit', time: new Date(Date.parse(d.date + 'T00:00:00Z') + between(7, 20) * 3600000), amount: d.amount, comment: 'Blik deposit' }),
    });

  // Degiro yearly exchange connection fees for exchanges with open positions at the end of the previous year
  const exchangeNames: Record<string, string> = { NDQ: 'Nasdaq - NDQ', NSY: 'NYSE - NSY', XET: 'Xetra - XET', EAM: 'Euronext Amsterdam - EAM' };
  for (let y = 2024; y <= +END.slice(0, 4); y++) {
    const date = `${y}-01-03`;
    events.push({
      date,
      order: 3,
      run: () => {
        const exchanges = new Set(Object.entries(DEGIRO).filter(([k]) => (hold.get(`DEGIRO:${k}`) ?? 0) > 0).map(([, i]) => i.exchange!));
        for (const ex of [...exchanges].sort())
          dAcc.push({ date, time: '07:30', valueDate: `${y - 1}-12-31`, product: '', isin: '', desc: `DEGIRO Exchange Connection Fee ${y} (${exchangeNames[ex]})`, fx: null, currency: 'EUR', change: -2.5, orderId: '' });
      },
    });
  }

  events.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
  for (const e of events) e.run();

  // XTB free-funds interest from the month-end cash balance
  xRows.sort((a, b) => a.time.getTime() - b.time.getTime());
  const interest: XtbRow[] = [];
  for (const m of monthly('2023-04', 1)) {
    const cutoff = Date.parse(m + 'T00:00:00Z');
    const cash = xRows.filter((r) => r.time.getTime() < cutoff).reduce((s, r) => s + r.amount, 0) + interest.reduce((s, r) => s + r.amount, 0);
    const gross = round((Math.max(0, cash) * xtbInterestRate(+m.slice(0, 4))) / 12);
    if (gross < 0.01) continue;
    const time = new Date(cutoff + 2 * 3600000);
    interest.push({ type: 'Free-funds Interest', time, amount: gross, comment: `Free-funds Interest ${m.slice(0, 7)}` });
    interest.push({ type: 'Free-funds Interest Tax', time, amount: -round(gross * 0.15), comment: `Free-funds Interest Tax ${m.slice(0, 7)}` });
  }
  xRows.push(...interest);
  xRows.sort((a, b) => a.time.getTime() - b.time.getTime());

  // ---------- write ----------
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'degiro'), { recursive: true });
  mkdirSync(join(OUT, 'xtb'), { recursive: true });

  const num = (x: number | null, d = 2) => (x == null ? '' : `"${x.toFixed(d).replace('.', ',')}"`);
  const txt = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const desc = <T extends { date: string; time: string }>(rows: T[]) => rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date + a.r.time < b.r.date + b.r.time ? 1 : a.r.date + a.r.time > b.r.date + b.r.time ? -1 : b.i - a.i)).map((x) => x.r);

  const tx = ['Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID'];
  for (const t of desc(dTx)) {
    const i = t.inst;
    tx.push(
      [dmy(t.date), t.time, txt(i.name), i.isin, i.exchange, t.orderId ? i.venue : '', String(t.qty), num(t.price, t.price < 20 ? 4 : 2), i.currency, num(t.local), i.currency, num(t.valueEur), num(t.rate, 4), num(t.autoFx), num(t.fee), num(round(t.valueEur + t.autoFx + t.fee)), t.orderId].join(','),
    );
  }
  writeFileSync(join(OUT, 'degiro', 'Transactions.csv'), tx.join('\n') + '\n');

  // running balance per currency in chronological order
  const bal = new Map<string, number>();
  const accChrono = dAcc.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date + a.r.time === b.r.date + b.r.time ? a.i - b.i : a.r.date + a.r.time < b.r.date + b.r.time ? -1 : 1));
  const balances = new Map<DegiroAcc, number>();
  let minEur = Infinity;
  for (const { r } of accChrono) {
    const b = round((bal.get(r.currency) ?? 0) + r.change);
    bal.set(r.currency, b);
    balances.set(r, b);
    if (r.currency === 'EUR') minEur = Math.min(minEur, b);
  }
  const acc = ['Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id'];
  for (const r of desc(dAcc))
    acc.push([dmy(r.date), r.time, dmy(r.valueDate), txt(r.product), r.isin, txt(r.desc), num(r.fx, 4), r.currency, num(r.change), r.currency, num(balances.get(r)!), r.orderId].join(','));
  writeFileSync(join(OUT, 'degiro', 'Account.csv'), acc.join('\n') + '\n');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash Operations');
  ws.addRow(['Account', XTB_ACCOUNT, 'Currency', 'CZK']);
  ws.addRow([]);
  ws.addRow(['Type', 'Instrument', 'Ticker', 'Category', 'Time', 'Amount', 'ID', 'Comment']);
  let id = 456000000;
  let cash = 0;
  let minCzk = Infinity;
  for (const r of xRows) {
    id += 1 + Math.floor(rnd() * 900);
    cash += r.amount;
    minCzk = Math.min(minCzk, cash);
    ws.addRow([r.type, r.inst?.name ?? '', r.inst?.xtbTicker ?? '', r.inst?.xtbCategory ?? '', r.time, round(r.amount), String(id), r.comment]);
  }
  ws.addRow(['Total', '', '', '', '', round(cash), '', '']);
  ws.getColumn(5).numFmt = 'dd.mm.yyyy hh:mm:ss';
  await wb.xlsx.writeFile(join(OUT, 'xtb', `CZK_${XTB_ACCOUNT}_${START}_${END}.xlsx`));

  console.log(`Degiro: ${dTx.length} transactions, ${dAcc.length} account rows, min EUR balance ${minEur.toFixed(2)}, end ${[...bal].map(([c, b]) => `${c} ${b}`).join(', ')}`);
  console.log(`XTB: ${xRows.length} cash operations, min CZK balance ${minCzk.toFixed(2)}, end ${cash.toFixed(2)}`);
  console.log('Holdings:', Object.fromEntries([...hold].filter(([, q]) => q > 0)));
}

await main();
