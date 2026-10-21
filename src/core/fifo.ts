import type { Broker, CorporateAction, Ledger, Trade } from './types.js';
import { addDays, addYears, daysBetween } from './util.js';

export type Converter = (amount: number, currency: string, date: string) => number;

export type LotOrigin = 'BUY' | 'FREE' | 'UNKNOWN';

export interface Lot {
  id: string;
  broker: Broker;
  instrumentId: string;
  acqDate: string;
  acqDateTime: string;
  qty: number;
  originalQty: number;
  /** Remaining acquisition cost (price part) in CZK */
  costCzk: number;
  /** Remaining purchase fees in CZK */
  feesCzk: number;
  /** Remaining acquisition cost in trade currency */
  costLocal: number;
  currency: string;
  origin: LotOrigin;
  notes: string[];
  /** First day on which a sale is exempt by the 3-year time test */
  timeTestDate: string;
  tradeId?: string;
}

export interface Realization {
  id: string;
  broker: Broker;
  instrumentId: string;
  tradeId: string;
  lotId: string;
  sellDate: string;
  sellDateTime: string;
  acqDate: string;
  qty: number;
  proceedsCzk: number;
  sellFeesCzk: number;
  costCzk: number;
  buyFeesCzk: number;
  gainCzk: number;
  proceedsLocal: number;
  costLocal: number;
  currency: string;
  sellPrice: number;
  holdingDays: number;
  timeTestPassed: boolean;
  timeTestDate: string;
  origin: LotOrigin;
}

export interface FifoResult {
  openLots: Lot[];
  realizations: Realization[];
  warnings: string[];
}

const EPS = 1e-9;

export function timeTestDate(acqDate: string): string {
  // exemption requires the holding period to EXCEED 3 years
  return addDays(addYears(acqDate, 3), 1);
}

export function passesTimeTest(acqDate: string, sellDate: string): boolean {
  return sellDate >= timeTestDate(acqDate);
}

type Ev = { t: 'trade'; dt: string; trade: Trade } | { t: 'action'; dt: string; action: CorporateAction };

export function runFifo(ledger: Ledger, conv: Converter): FifoResult {
  const books = new Map<string, Lot[]>();
  const realizations: Realization[] = [];
  const warnings: string[] = [];
  const key = (b: Broker, id: string) => `${b}|${id}`;
  const book = (k: string) => {
    let l = books.get(k);
    if (!l) {
      l = [];
      books.set(k, l);
    }
    return l;
  };

  const events: Ev[] = [
    ...ledger.actions.map((a) => ({ t: 'action' as const, dt: a.dateTime, action: a })),
    ...ledger.trades.map((t) => ({ t: 'trade' as const, dt: t.dateTime, trade: t })),
  ];
  events.sort((a, b) => {
    if (a.dt !== b.dt) return a.dt < b.dt ? -1 : 1;
    if (a.t !== b.t) return a.t === 'action' ? -1 : 1;
    if (a.t === 'trade' && b.t === 'trade') return b.trade.quantity - a.trade.quantity; // buys first
    return 0;
  });

  let lotSeq = 0;
  for (const ev of events) {
    if (ev.t === 'action') {
      const a = ev.action;
      if (a.kind === 'SPLIT') {
        for (const lot of book(key(a.broker, a.instrumentId))) {
          lot.qty *= a.ratio;
          lot.originalQty *= a.ratio;
          lot.notes.push(`${a.date}: split ${a.ratio}:1`);
        }
      } else if (a.kind === 'CONVERSION') {
        const from = book(key(a.broker, a.fromId));
        const to = book(key(a.broker, a.toId));
        for (const lot of from.splice(0)) {
          lot.qty *= a.ratio;
          lot.originalQty *= a.ratio;
          lot.instrumentId = a.toId;
          lot.notes.push(`${a.date}: ${a.note}`);
          to.push(lot);
        }
        to.sort((x, y) => (x.acqDateTime < y.acqDateTime ? -1 : x.acqDateTime > y.acqDateTime ? 1 : 0));
      } else if (a.kind === 'FREE_SHARES') {
        const inst = ledger.instruments.get(a.instrumentId);
        book(key(a.broker, a.instrumentId)).push({
          id: `L${++lotSeq}`,
          broker: a.broker,
          instrumentId: a.instrumentId,
          acqDate: a.date,
          acqDateTime: a.dateTime,
          qty: a.quantity,
          originalQty: a.quantity,
          costCzk: 0,
          feesCzk: 0,
          costLocal: 0,
          currency: inst?.currency ?? 'EUR',
          origin: 'FREE',
          notes: [a.note],
          timeTestDate: timeTestDate(a.date),
        });
      }
      continue;
    }

    const tr = ev.trade;
    const k = key(tr.broker, tr.instrumentId);
    const lots = book(k);
    const grossCzk = tr.amountCzk ?? conv(tr.amount, tr.currency, tr.date);
    const feesCzk = tr.fees.reduce((s, f) => s + conv(f.amount, f.currency, tr.date), 0);

    if (tr.quantity > 0) {
      lots.push({
        id: `L${++lotSeq}`,
        broker: tr.broker,
        instrumentId: tr.instrumentId,
        acqDate: tr.date,
        acqDateTime: tr.dateTime,
        qty: tr.quantity,
        originalQty: tr.quantity,
        costCzk: grossCzk,
        feesCzk,
        costLocal: tr.amount,
        currency: tr.currency,
        origin: 'BUY',
        notes: [],
        timeTestDate: timeTestDate(tr.date),
        tradeId: tr.id,
      });
      continue;
    }

    // Sale – consume lots FIFO
    const sellQty = -tr.quantity;
    let remaining = sellQty;
    while (remaining > EPS) {
      const lot = lots[0];
      if (!lot) {
        warnings.push(
          `Prodej ${tr.date} ${ledger.instruments.get(tr.instrumentId)?.name ?? tr.instrumentId}: chybí nákup pro ${round6(remaining)} ks – pořizovací cena 0.`,
        );
        realizations.push(makeRealization(tr, null, remaining, sellQty, grossCzk, feesCzk, `X${++lotSeq}`));
        break;
      }
      const take = Math.min(lot.qty, remaining);
      realizations.push(makeRealization(tr, lot, take, sellQty, grossCzk, feesCzk, lot.id));
      const frac = take / lot.qty;
      lot.costCzk -= lot.costCzk * frac;
      lot.feesCzk -= lot.feesCzk * frac;
      lot.costLocal -= lot.costLocal * frac;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= EPS * Math.max(1, lot.originalQty)) lots.shift();
    }
  }

  const openLots: Lot[] = [];
  for (const lots of books.values()) for (const l of lots) if (l.qty > EPS) openLots.push(l);
  openLots.sort((a, b) => (a.acqDateTime < b.acqDateTime ? -1 : 1));
  return { openLots, realizations, warnings };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function makeRealization(tr: Trade, lot: Lot | null, qty: number, sellQty: number, grossCzk: number, feesCzk: number, lotId: string): Realization {
  const share = qty / sellQty;
  const proceedsCzk = grossCzk * share;
  const sellFeesCzk = feesCzk * share;
  const frac = lot ? qty / lot.qty : 0;
  const costCzk = lot ? lot.costCzk * frac : 0;
  const buyFeesCzk = lot ? lot.feesCzk * frac : 0;
  const acqDate = lot?.acqDate ?? tr.date;
  const ttDate = timeTestDate(acqDate);
  return {
    id: `${tr.id}#${lotId}`,
    broker: tr.broker,
    instrumentId: tr.instrumentId,
    tradeId: tr.id,
    lotId,
    sellDate: tr.date,
    sellDateTime: tr.dateTime,
    acqDate,
    qty,
    proceedsCzk,
    sellFeesCzk,
    costCzk,
    buyFeesCzk,
    gainCzk: proceedsCzk - sellFeesCzk - costCzk - buyFeesCzk,
    proceedsLocal: tr.amount * share,
    costLocal: lot ? lot.costLocal * frac : 0,
    currency: tr.currency,
    sellPrice: tr.price,
    holdingDays: daysBetween(acqDate, tr.date),
    timeTestPassed: lot ? tr.date >= ttDate : false,
    timeTestDate: ttDate,
    origin: lot?.origin ?? 'UNKNOWN',
  };
}
