import type { Converter } from '../fifo.js';
import type { Broker, Ledger } from '../types.js';
import { CZ_DIVIDEND_RATE, ISSUER_COUNTRY_BY_ISIN, treatyRate } from './treaties.js';

export interface DividendPayment {
  id: string;
  broker: Broker;
  instrumentId: string;
  name: string;
  date: string;
  year: number;
  country: string;
  currency: string;
  gross: number;
  withheld: number;
  net: number;
  grossCzk: number;
  withheldCzk: number;
  netCzk: number;
  /** Net amount converted with the daily CNB rate (for performance analytics) */
  netCzkDaily: number;
  treatyRate: number | null;
  /** Foreign tax creditable in the Czech return */
  creditableCzk: number;
  /** Tax withheld above the treaty rate – may be reclaimed from the foreign tax authority */
  reclaimable: number;
  reclaimableCzk: number;
  /** Czech tax (15 %) before credit */
  czTaxCzk: number;
  /** Czech tax still payable after credit */
  dueCzk: number;
  /** Czech-source dividend already taxed with final withholding tax */
  finalTaxed: boolean;
  /** Return of capital (treated conservatively as dividend income) */
  capitalReturn: boolean;
}

export interface DividendCountrySummary {
  country: string;
  count: number;
  grossCzk: number;
  withheldCzk: number;
  creditableCzk: number;
  czTaxCzk: number;
  dueCzk: number;
  reclaimableCzk: number;
  treatyRate: number | null;
}

export interface DividendYearReport {
  year: number;
  payments: DividendPayment[];
  byCountry: DividendCountrySummary[];
  foreign: { grossCzk: number; withheldCzk: number; creditableCzk: number; czTaxCzk: number; dueCzk: number; reclaimableCzk: number };
  domesticFinal: { grossCzk: number; withheldCzk: number };
  netCzk: number;
}

export function issuerCountry(ledger: Ledger, instrumentId: string | undefined, overrides: Record<string, string> = {}): string {
  if (!instrumentId) return 'XX';
  if (overrides[instrumentId]) return overrides[instrumentId];
  const inst = ledger.instruments.get(instrumentId);
  if (inst?.isin && ISSUER_COUNTRY_BY_ISIN[inst.isin]) return ISSUER_COUNTRY_BY_ISIN[inst.isin];
  return inst?.country ?? inst?.isin?.slice(0, 2) ?? 'XX';
}

export function buildDividendPayments(
  ledger: Ledger,
  taxConv: Converter,
  dailyConv: Converter,
  opts: { countryOverrides?: Record<string, string>; treatyOverrides?: Record<string, number> } = {},
): DividendPayment[] {
  const groups = new Map<string, { broker: Broker; instrumentId: string; date: string; currency: string; gross: number; withheld: number; capitalReturn: boolean }>();
  for (const c of ledger.cash) {
    if (c.kind !== 'DIVIDEND' && c.kind !== 'DIVIDEND_TAX' && c.kind !== 'CAPITAL_RETURN') continue;
    const instrumentId = c.instrumentId ?? 'UNKNOWN';
    const k = `${c.broker}|${instrumentId}|${c.date}|${c.currency}`;
    let g = groups.get(k);
    if (!g) {
      g = { broker: c.broker, instrumentId, date: c.date, currency: c.currency, gross: 0, withheld: 0, capitalReturn: false };
      groups.set(k, g);
    }
    if (c.kind === 'DIVIDEND_TAX') g.withheld -= c.amount;
    else {
      g.gross += c.amount;
      if (c.kind === 'CAPITAL_RETURN') g.capitalReturn = true;
    }
  }

  const out: DividendPayment[] = [];
  for (const [k, g] of groups) {
    if (Math.abs(g.gross) < 1e-9 && Math.abs(g.withheld) < 1e-9) continue;
    const country = issuerCountry(ledger, g.instrumentId, opts.countryOverrides);
    const finalTaxed = country === 'CZ';
    const rate = finalTaxed ? CZ_DIVIDEND_RATE : treatyRate(country, opts.treatyOverrides);
    const grossCzk = taxConv(g.gross, g.currency, g.date);
    const withheldCzk = taxConv(g.withheld, g.currency, g.date);
    const czTaxCzk = finalTaxed ? 0 : Math.max(0, grossCzk * CZ_DIVIDEND_RATE);
    const creditableCzk = finalTaxed || rate === null ? 0 : Math.max(0, Math.min(withheldCzk, grossCzk * rate, czTaxCzk));
    const reclaimable = rate === null || finalTaxed ? 0 : Math.max(0, g.withheld - g.gross * rate);
    out.push({
      id: k,
      broker: g.broker,
      instrumentId: g.instrumentId,
      name: ledger.instruments.get(g.instrumentId)?.name ?? g.instrumentId,
      date: g.date,
      year: Number(g.date.slice(0, 4)),
      country,
      currency: g.currency,
      gross: g.gross,
      withheld: g.withheld,
      net: g.gross - g.withheld,
      grossCzk,
      withheldCzk,
      netCzk: grossCzk - withheldCzk,
      netCzkDaily: dailyConv(g.gross - g.withheld, g.currency, g.date),
      treatyRate: rate,
      creditableCzk,
      reclaimable,
      reclaimableCzk: taxConv(reclaimable, g.currency, g.date),
      czTaxCzk,
      dueCzk: Math.max(0, czTaxCzk - creditableCzk),
      finalTaxed,
      capitalReturn: g.capitalReturn,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
  return out;
}

export function dividendYearReport(payments: DividendPayment[], year: number): DividendYearReport {
  const ps = payments.filter((p) => p.year === year);
  const byC = new Map<string, DividendCountrySummary>();
  const foreign = { grossCzk: 0, withheldCzk: 0, creditableCzk: 0, czTaxCzk: 0, dueCzk: 0, reclaimableCzk: 0 };
  const domesticFinal = { grossCzk: 0, withheldCzk: 0 };
  for (const p of ps) {
    if (p.finalTaxed) {
      domesticFinal.grossCzk += p.grossCzk;
      domesticFinal.withheldCzk += p.withheldCzk;
      continue;
    }
    let s = byC.get(p.country);
    if (!s) {
      s = { country: p.country, count: 0, grossCzk: 0, withheldCzk: 0, creditableCzk: 0, czTaxCzk: 0, dueCzk: 0, reclaimableCzk: 0, treatyRate: p.treatyRate };
      byC.set(p.country, s);
    }
    s.count++;
    s.grossCzk += p.grossCzk;
    s.withheldCzk += p.withheldCzk;
    s.creditableCzk += p.creditableCzk;
    s.czTaxCzk += p.czTaxCzk;
    s.dueCzk += p.dueCzk;
    s.reclaimableCzk += p.reclaimableCzk;
    foreign.grossCzk += p.grossCzk;
    foreign.withheldCzk += p.withheldCzk;
    foreign.creditableCzk += p.creditableCzk;
    foreign.czTaxCzk += p.czTaxCzk;
    foreign.dueCzk += p.dueCzk;
    foreign.reclaimableCzk += p.reclaimableCzk;
  }
  return {
    year,
    payments: ps,
    byCountry: [...byC.values()].sort((a, b) => b.grossCzk - a.grossCzk),
    foreign,
    domesticFinal,
    netCzk: ps.reduce((s, p) => s + p.netCzk, 0),
  };
}
