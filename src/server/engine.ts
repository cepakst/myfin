import { readFileSync } from 'node:fs';
import { computeInsights, type Insights } from '../core/analytics/insights.js';
import { buildTips, type FxMethodComparison, type Tip } from '../core/analytics/optimization.js';
import { computePerformance, type PerformanceResult } from '../core/analytics/performance.js';
import { buildLotViews, buildPositions, type LotView, type PositionView } from '../core/analytics/portfolio.js';
import { makePriceProvider, type PriceProvider, type SeriesLike } from '../core/analytics/prices.js';
import { runFifo, type Converter, type Realization } from '../core/fifo.js';
import { FxRates, type CnbFixing } from '../core/fx.js';
import { buildLedger } from '../core/parsers/index.js';
import { profileFor, withYearProfile, type Settings } from '../core/settings.js';
import { dapDividends, dapSecurities, type DapBlock } from '../core/tax/dap.js';
import { buildDividendPayments, dividendYearReport, type DividendPayment, type DividendYearReport } from '../core/tax/dividends.js';
import { highRateThreshold, securitiesYearReport, type SecuritiesYearReport } from '../core/tax/securities.js';
import { yearTaxSummary, type YearTaxSummary } from '../core/tax/summary.js';
import type { CashEvent, Instrument, Ledger, Trade } from '../core/types.js';
import { todayIso } from '../core/util.js';
import { loadCnbFixings } from './cnb.js';
import { MarketData, type SymbolInfo } from './market.js';
import { DEFAULT_EXPORTS_DIR } from './paths.js';
import { listExportFiles } from './store.js';

export interface RealizationView extends Realization {
  name: string;
  econProceedsCzk: number;
  econCostCzk: number;
  econGainCzk: number;
}

export interface FxYearInfo {
  year: number;
  method: string;
  rates: { currency: string; rate: number; provisional: boolean; source: string }[];
}

export interface Snapshot {
  generatedAt: string;
  today: string;
  exportsDir: string;
  files: string[];
  sources: Ledger['sources'];
  warnings: { source: string; message: string }[];
  years: number[];
  instruments: (Instrument & { symbol: string | null; symbolSource: string; symbolNote?: string; hasMarket: boolean })[];
  performance: PerformanceResult;
  positions: PositionView[];
  lots: LotView[];
  realizations: RealizationView[];
  securities: Omit<SecuritiesYearReport, 'realizations'>[];
  dividends: DividendPayment[];
  dividendYears: Omit<DividendYearReport, 'payments'>[];
  taxSummaries: YearTaxSummary[];
  dap: { year: number; blocks: DapBlock[] }[];
  insights: Insights;
  /** Insights restricted to a single calendar year */
  insightsByYear: Record<number, Insights>;
  tips: Tip[];
  fxComparison: FxMethodComparison[];
  /** Tax estimates for every combination of FX method and dividend taxation per year (with the year's situation) */
  taxScenarios: Record<number, TaxScenario[]>;
  fxYears: FxYearInfo[];
  cnbLastDate: string;
}

export interface TaxScenario {
  fxMethod: 'UNIFIED' | 'DAILY';
  use16a: boolean;
  securitiesBaseCzk: number;
  foreignDividendsCzk: number;
  estimatedTaxSecuritiesCzk: number;
  estimatedTaxDividendsCzk: number;
  estimatedTaxTotalCzk: number;
  mustFile: boolean | null;
}

export interface EngineState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  progress: string[];
  error?: string;
  snapshot?: Snapshot;
  ledger?: Ledger;
  market?: MarketData;
  prices?: PriceProvider;
  fx?: FxRates;
}

export const state: EngineState = { status: 'idle', progress: [] };

function convOf(fx: FxRates, mode: 'tax' | 'daily'): Converter {
  return mode === 'tax' ? (a, c, d) => fx.toCzkTax(a, c, d) : (a, c, d) => fx.toCzkDaily(a, c, d);
}

/** Cash received in corporate actions (cash in lieu, takeover cash) treated as §10 sale proceeds without cost */
function corporateCashRealizations(ledger: Ledger, conv: Converter): Realization[] {
  return ledger.cash
    .filter((c): c is CashEvent & { instrumentId: string } => c.kind === 'CORPORATE_CASH' && !!c.instrumentId && c.amount > 0)
    .map((c) => {
      const czk = conv(c.amount, c.currency, c.date);
      return {
        id: `CC:${c.id}`,
        broker: c.broker,
        instrumentId: c.instrumentId,
        tradeId: `CC:${c.id}`,
        lotId: '-',
        sellDate: c.date,
        sellDateTime: c.dateTime,
        acqDate: c.date,
        qty: 0,
        proceedsCzk: czk,
        sellFeesCzk: 0,
        costCzk: 0,
        buyFeesCzk: 0,
        gainCzk: czk,
        proceedsLocal: c.amount,
        costLocal: 0,
        currency: c.currency,
        sellPrice: 0,
        holdingDays: 0,
        timeTestPassed: false,
        timeTestDate: c.date,
        origin: 'UNKNOWN',
      } satisfies Realization;
    });
}

/** Positive interest without final withholding (XTB withholds 15 % on free-funds interest – verified by INTEREST_TAX rows) */
function otherCapitalByYear(ledger: Ledger, conv: Converter): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of ledger.cash) {
    if (c.kind === 'INTEREST' && c.amount > 0 && c.broker !== 'XTB') {
      const y = Number(c.date.slice(0, 4));
      m.set(y, (m.get(y) ?? 0) + conv(c.amount, c.currency, c.date));
    }
  }
  return m;
}

type FxMethod = 'UNIFIED' | 'DAILY';
interface TaxVariant {
  sec: SecuritiesYearReport;
  div: DividendYearReport;
  otherCapitalCzk: number;
}

/**
 * Tax inputs of year `y` when that year used `method` and all other years keep their selected method
 * (purchase costs of older lots are converted with the method chosen for the purchase year).
 */
function taxVariant(ledger: Ledger, fixings: CnbFixing[], settings: Settings, y: number, method: FxMethod): TaxVariant {
  const conv = convOf(new FxRates(fixings, { ...settings.fx, methodByYear: { ...settings.fx.methodByYear, [y]: method } }), 'tax');
  const rs = [...runFifo(ledger, conv).realizations, ...corporateCashRealizations(ledger, conv)];
  const pays = buildDividendPayments(ledger, conv, conv, { countryOverrides: settings.countryOverrides, treatyOverrides: settings.treatyOverrides });
  return { sec: securitiesYearReport(rs, y), div: dividendYearReport(pays, y), otherCapitalCzk: otherCapitalByYear(ledger, conv).get(y) ?? 0 };
}

/** Year summaries under both FX methods and both dividend options so the user can compare them */
function taxScenarios(variants: Map<number, Record<FxMethod, TaxVariant>>, settings: Settings): Record<number, TaxScenario[]> {
  const out: Record<number, TaxScenario[]> = {};
  for (const [y, byMethod] of variants) {
    out[y] = [];
    for (const fxMethod of ['UNIFIED', 'DAILY'] as const) {
      const { sec, div, otherCapitalCzk } = byMethod[fxMethod];
      for (const use16a of y >= 2021 ? [true, false] : [false]) {
        const sum = yearTaxSummary(withYearProfile(settings, y, { foreign16a: use16a }), sec, div, otherCapitalCzk);
        out[y].push({
          fxMethod,
          use16a,
          securitiesBaseCzk: sec.taxable.baseCzk,
          foreignDividendsCzk: div.foreign.grossCzk,
          estimatedTaxSecuritiesCzk: sum.estimatedTaxSecuritiesCzk,
          estimatedTaxDividendsCzk: sum.estimatedTaxDividendsCzk,
          estimatedTaxTotalCzk: sum.estimatedTaxTotalCzk,
          mustFile: sum.mustFile,
        });
      }
    }
  }
  return out;
}

export async function computeSnapshot(settings: Settings, opts: { refreshMarket?: boolean } = {}): Promise<void> {
  state.status = 'loading';
  state.progress = [];
  state.error = undefined;
  const log = (m: string) => {
    state.progress.push(m);
    if (state.progress.length > 50) state.progress.shift();
  };
  try {
    const exportsDir = settings.exportsDir || DEFAULT_EXPORTS_DIR;
    const files = listExportFiles(exportsDir);
    log(`Načítám ${files.length} souborů z ${exportsDir}`);
    const ledger = await buildLedger(files.map((p) => ({ name: p, data: new Uint8Array(readFileSync(p)) })));
    for (const [id, c] of Object.entries(settings.countryOverrides)) {
      const inst = ledger.instruments.get(id);
      if (inst && c) inst.country = c;
    }
    const today = todayIso();
    const allDates = [...ledger.trades.map((t) => t.date), ...ledger.cash.map((c) => c.date)].sort();
    const firstYear = allDates.length ? Number(allDates[0].slice(0, 4)) : Number(today.slice(0, 4));
    const lastYear = Number(today.slice(0, 4));
    const years: number[] = [];
    for (let y = firstYear; y <= lastYear; y++) years.push(y);

    log('Kurzy ČNB');
    const cnb = await loadCnbFixings(firstYear, lastYear, log);
    for (const e of cnb.errors) ledger.warnings.push({ source: 'ČNB', message: e });
    const fixings: CnbFixing[] = cnb.fixings;
    const fx = new FxRates(fixings, settings.fx);

    const taxConv = convOf(fx, 'tax');
    const dailyConv = convOf(fx, 'daily');

    log('Tržní ceny (Yahoo Finance)');
    const market = state.market ?? new MarketData(log);
    await market.loadAll(ledger, settings.symbolOverrides, { force: opts.refreshMarket });
    for (const e of market.errors.splice(0)) ledger.warnings.push({ source: 'Yahoo', message: e });
    const seriesMap = new Map<string, SeriesLike>();
    for (const id of ledger.instruments.keys()) {
      const s = market.getSeries(id);
      if (s) seriesMap.set(id, s);
    }
    const prices = makePriceProvider(ledger, seriesMap);

    log('FIFO a daně');
    const taxFifo = runFifo(ledger, taxConv);
    const econFifo = runFifo(ledger, dailyConv);
    for (const w of taxFifo.warnings) ledger.warnings.push({ source: 'FIFO', message: w });
    const ccTax = corporateCashRealizations(ledger, taxConv);
    const ccEcon = corporateCashRealizations(ledger, dailyConv);
    const taxReal = [...taxFifo.realizations, ...ccTax];
    const econReal = [...econFifo.realizations, ...ccEcon];
    const econById = new Map(econReal.map((r) => [r.id, r]));
    const name = (id: string) => ledger.instruments.get(id)?.name ?? id;
    const realizations: RealizationView[] = taxReal.map((r) => {
      const e = econById.get(r.id);
      return {
        ...r,
        name: name(r.instrumentId),
        econProceedsCzk: e?.proceedsCzk ?? r.proceedsCzk,
        econCostCzk: (e?.costCzk ?? r.costCzk) + (e?.buyFeesCzk ?? r.buyFeesCzk),
        econGainCzk: e?.gainCzk ?? r.gainCzk,
      };
    });

    const dividends = buildDividendPayments(ledger, taxConv, dailyConv, { countryOverrides: settings.countryOverrides, treatyOverrides: settings.treatyOverrides });
    const divByInst = new Map<string, number>();
    for (const d of dividends) divByInst.set(d.instrumentId, (divByInst.get(d.instrumentId) ?? 0) + d.netCzkDaily);

    const secReports = years.map((y) => securitiesYearReport(taxReal, y));
    const divReports = years.map((y) => dividendYearReport(dividends, y));
    const otherCapital = otherCapitalByYear(ledger, taxConv);
    const taxSummaries = years.map((y, i) => yearTaxSummary(settings, secReports[i], divReports[i], otherCapital.get(y) ?? 0));

    log('Výkonnost portfolia');
    const performance = computePerformance(ledger, prices, dailyConv, econReal, today);
    const lots = buildLotViews(ledger, econFifo.openLots, taxFifo.openLots, prices, dailyConv, today);
    const positions = buildPositions(ledger, lots, econReal, divByInst);
    const twrByDate = new Map(performance.daily.map((p) => [p.date, p.twr]));
    const insightOpts = { twrAt: (d: string) => twrByDate.get(d) };
    const insights = computeInsights(ledger, econReal, dividends, prices, dailyConv, today, insightOpts);
    const insightsByYear = Object.fromEntries(years.map((y) => [y, computeInsights(ledger, econReal, dividends, prices, dailyConv, today, { ...insightOpts, year: y })]));

    log('Varianty zdanění');
    // the selected method reuses the main computation; only the alternative needs an extra FIFO run per year
    const variants = new Map<number, Record<FxMethod, TaxVariant>>();
    years.forEach((y, i) => {
      const selected: FxMethod = fx.methodFor(y);
      const main: TaxVariant = { sec: secReports[i], div: divReports[i], otherCapitalCzk: otherCapital.get(y) ?? 0 };
      const other: FxMethod = selected === 'UNIFIED' ? 'DAILY' : 'UNIFIED';
      variants.set(y, { [selected]: main, [other]: taxVariant(ledger, fixings, settings, y, other) } as Record<FxMethod, TaxVariant>);
    });
    // dividend base after credit: due tax / 15 %
    const fxBases = (v: TaxVariant) => ({ sec: Math.max(0, v.sec.taxable.resultCzk), div: v.div.foreign.dueCzk / 0.15 });
    const fxComparison: FxMethodComparison[] = years
      .filter((y) => y < lastYear || fx.unified('USD', y).provisional === false)
      .map((y) => {
        const u = fxBases(variants.get(y)!.UNIFIED);
        const d = fxBases(variants.get(y)!.DAILY);
        return { year: y, unifiedBaseCzk: u.sec, dailyBaseCzk: d.sec, unifiedDividendBaseCzk: u.div, dailyDividendBaseCzk: d.div };
      });

    const curYearIdx = years.indexOf(lastYear);
    const tips = buildTips({
      year: lastYear,
      lots,
      report: secReports[curYearIdx],
      dividends,
      fxComparison: fxComparison.filter((c) => c.year >= lastYear - 1),
      dividendChoices: taxSummaries.filter((t) => t.year >= lastYear - 1),
      taxRate: (profileFor(settings, lastYear).otherTaxBase ?? 0) > highRateThreshold(lastYear) ? 0.23 : 0.15,
      today,
    });

    const currencies = [...new Set([...ledger.trades.map((t) => t.currency), ...ledger.cash.map((c) => c.currency)])].filter((c) => c !== 'CZK').sort();
    const fxYears: FxYearInfo[] = years.map((y) => ({
      year: y,
      method: fx.methodFor(y),
      rates: currencies.filter((c) => fx.hasCurrency(c)).map((c) => ({ currency: c, ...fx.unified(c, y) })),
    }));

    const symbols: Record<string, SymbolInfo> = market.symbolMap();
    state.snapshot = {
      generatedAt: new Date().toISOString(),
      today,
      exportsDir,
      files,
      sources: ledger.sources,
      warnings: ledger.warnings,
      years,
      instruments: [...ledger.instruments.values()].map((i) => ({
        ...i,
        symbol: symbols[i.id]?.symbol ?? null,
        symbolSource: symbols[i.id]?.source ?? 'none',
        symbolNote: symbols[i.id]?.note,
        hasMarket: seriesMap.has(i.id),
      })),
      performance,
      positions,
      lots,
      realizations,
      securities: secReports.map(({ realizations: _r, ...rest }) => rest),
      dividends,
      dividendYears: divReports.map(({ payments: _p, ...rest }) => rest),
      taxSummaries,
      dap: years.map((y, i) => ({
        year: y,
        blocks: [
          dapSecurities(secReports[i]),
          ...dapDividends(divReports[i], y, { use16a: taxSummaries[i].use16a, generalBaseCzk: taxSummaries[i].generalBaseCzk, otherCapitalCzk: otherCapital.get(y) ?? 0 }),
        ],
      })),
      insights,
      insightsByYear,
      tips,
      fxComparison,
      taxScenarios: taxScenarios(variants, settings),
      fxYears,
      cnbLastDate: fx.lastDate,
    };
    state.ledger = ledger;
    state.market = market;
    state.prices = prices;
    state.fx = fx;
    state.status = 'ready';
    log('Hotovo');
  } catch (e) {
    state.status = 'error';
    state.error = (e as Error).stack ?? String(e);
    log(`Chyba: ${(e as Error).message}`);
  }
}

export interface InstrumentDetail {
  instrument: Instrument;
  prices: { date: string; close: number }[];
  currency: string | null;
  trades: Trade[];
  dividends: DividendPayment[];
  lots: LotView[];
  realizations: RealizationView[];
}

export function instrumentDetail(id: string): InstrumentDetail | null {
  const snap = state.snapshot;
  const ledger = state.ledger;
  if (!snap || !ledger) return null;
  const inst = ledger.instruments.get(id);
  if (!inst) return null;
  const s = state.market?.getSeries(id);
  return {
    instrument: inst,
    prices: s ? s.dates.map((d, i) => ({ date: d, close: s.closes[i] })) : [],
    currency: s?.currency ?? null,
    trades: ledger.trades.filter((t) => t.instrumentId === id),
    dividends: snap.dividends.filter((d) => d.instrumentId === id),
    lots: snap.lots.filter((l) => l.instrumentId === id),
    realizations: snap.realizations.filter((r) => r.instrumentId === id),
  };
}
