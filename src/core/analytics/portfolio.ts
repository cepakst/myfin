import type { Converter, Lot, Realization } from '../fifo.js';
import type { Ledger } from '../types.js';
import { daysBetween, todayIso } from '../util.js';
import type { PriceProvider } from './prices.js';

export interface LotView {
  id: string;
  broker: string;
  instrumentId: string;
  name: string;
  acqDate: string;
  qty: number;
  origin: string;
  notes: string[];
  costCzk: number;
  feesCzk: number;
  /** Tax-basis cost incl. fees (with the configured tax FX method) */
  taxCostCzk: number;
  price: number | null;
  priceCurrency: string | null;
  priceDate: string | null;
  priceSource: string | null;
  valueCzk: number | null;
  unrealizedCzk: number | null;
  unrealizedPct: number | null;
  /** Gain vs tax basis if sold today (current value − tax cost) */
  taxGainCzk: number | null;
  timeTestDate: string;
  timeTestPassed: boolean;
  daysToTimeTest: number;
  /** 0..1 progress of the 3-year holding period */
  timeTestProgress: number;
}

export interface PositionView {
  instrumentId: string;
  name: string;
  isin?: string;
  type: string;
  brokers: string[];
  qty: number;
  costCzk: number;
  valueCzk: number | null;
  unrealizedCzk: number | null;
  unrealizedPct: number | null;
  weight: number | null;
  lots: number;
  timeTestedQty: number;
  timeTestedValueCzk: number;
  nextTimeTestDate: string | null;
  price: number | null;
  priceCurrency: string | null;
  priceSource: string | null;
  priceDate: string | null;
  realizedCzk: number;
  dividendsCzk: number;
}

export function buildLotViews(ledger: Ledger, econLots: Lot[], taxLots: Lot[], prices: PriceProvider, dailyConv: Converter, today = todayIso()): LotView[] {
  const taxById = new Map(taxLots.map((l) => [l.id, l]));
  return econLots.map((l) => {
    const q = prices.price(l.instrumentId, today);
    const valueCzk = q ? l.qty * dailyConv(q.price, q.currency, today) : null;
    const cost = l.costCzk + l.feesCzk;
    const tl = taxById.get(l.id);
    const taxCost = tl ? tl.costCzk + tl.feesCzk : cost;
    const total = daysBetween(l.acqDate, l.timeTestDate);
    const held = daysBetween(l.acqDate, today);
    return {
      id: l.id,
      broker: l.broker,
      instrumentId: l.instrumentId,
      name: ledger.instruments.get(l.instrumentId)?.name ?? l.instrumentId,
      acqDate: l.acqDate,
      qty: l.qty,
      origin: l.origin,
      notes: l.notes,
      costCzk: l.costCzk,
      feesCzk: l.feesCzk,
      taxCostCzk: taxCost,
      price: q?.price ?? null,
      priceCurrency: q?.currency ?? null,
      priceDate: q?.date ?? null,
      priceSource: q?.source ?? null,
      valueCzk,
      unrealizedCzk: valueCzk == null ? null : valueCzk - cost,
      unrealizedPct: valueCzk == null || cost <= 0 ? null : valueCzk / cost - 1,
      taxGainCzk: valueCzk == null ? null : valueCzk - taxCost,
      timeTestDate: l.timeTestDate,
      timeTestPassed: today >= l.timeTestDate,
      daysToTimeTest: Math.max(0, daysBetween(today, l.timeTestDate)),
      timeTestProgress: Math.max(0, Math.min(1, held / total)),
    };
  });
}

export function buildPositions(ledger: Ledger, lots: LotView[], realizations: Realization[], dividendsByInstrument: Map<string, number>): PositionView[] {
  const map = new Map<string, PositionView>();
  const get = (id: string) => {
    let p = map.get(id);
    if (!p) {
      const inst = ledger.instruments.get(id);
      p = {
        instrumentId: id,
        name: inst?.name ?? id,
        isin: inst?.isin,
        type: inst?.type ?? 'OTHER',
        brokers: [],
        qty: 0,
        costCzk: 0,
        valueCzk: 0,
        unrealizedCzk: 0,
        unrealizedPct: null,
        weight: null,
        lots: 0,
        timeTestedQty: 0,
        timeTestedValueCzk: 0,
        nextTimeTestDate: null,
        price: null,
        priceCurrency: null,
        priceSource: null,
        priceDate: null,
        realizedCzk: 0,
        dividendsCzk: dividendsByInstrument.get(id) ?? 0,
      };
      map.set(id, p);
    }
    return p;
  };
  for (const l of lots) {
    const p = get(l.instrumentId);
    if (!p.brokers.includes(l.broker)) p.brokers.push(l.broker);
    p.qty += l.qty;
    p.costCzk += l.costCzk + l.feesCzk;
    p.lots++;
    if (l.valueCzk == null) p.valueCzk = null;
    else if (p.valueCzk != null) p.valueCzk += l.valueCzk;
    if (l.timeTestPassed) {
      p.timeTestedQty += l.qty;
      p.timeTestedValueCzk += l.valueCzk ?? 0;
    } else if (!p.nextTimeTestDate || l.timeTestDate < p.nextTimeTestDate) p.nextTimeTestDate = l.timeTestDate;
    p.price = l.price;
    p.priceCurrency = l.priceCurrency;
    p.priceSource = l.priceSource;
    p.priceDate = l.priceDate;
  }
  for (const r of realizations) get(r.instrumentId).realizedCzk += r.gainCzk;
  for (const id of dividendsByInstrument.keys()) get(id);
  const out = [...map.values()];
  const total = out.reduce((s, p) => s + (p.qty > 1e-9 ? (p.valueCzk ?? 0) : 0), 0);
  for (const p of out) {
    if (p.qty <= 1e-9) {
      p.valueCzk = 0;
      p.unrealizedCzk = 0;
      continue;
    }
    p.unrealizedCzk = p.valueCzk == null ? null : p.valueCzk - p.costCzk;
    p.unrealizedPct = p.valueCzk == null || p.costCzk <= 0 ? null : p.valueCzk / p.costCzk - 1;
    p.weight = p.valueCzk == null || total <= 0 ? null : p.valueCzk / total;
  }
  return out.sort((a, b) => (b.valueCzk ?? 0) - (a.valueCzk ?? 0));
}
