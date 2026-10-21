import type { DividendPayment } from '../tax/dividends.js';
import { SMALL_SALES_LIMIT, type SecuritiesYearReport } from '../tax/securities.js';
import { countryName } from '../tax/treaties.js';
import { addDays, todayIso } from '../util.js';
import type { LotView } from './portfolio.js';

export interface TipItem {
  lotId?: string;
  instrumentId: string;
  name: string;
  acqDate?: string;
  qty?: number;
  timeTestDate?: string;
  valueCzk?: number | null;
  gainCzk?: number | null;
  note?: string;
}

export interface Tip {
  id: string;
  severity: 'info' | 'warning' | 'success';
  title: string;
  text: string;
  amountCzk?: number;
  items?: TipItem[];
}

export interface FxMethodComparison {
  year: number;
  unifiedBaseCzk: number;
  dailyBaseCzk: number;
  unifiedDividendBaseCzk: number;
  dailyDividendBaseCzk: number;
}

const fmt = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

export function buildTips(opts: {
  year: number;
  lots: LotView[];
  report: SecuritiesYearReport;
  dividends: DividendPayment[];
  fxComparison: FxMethodComparison[];
  taxRate?: number;
  today?: string;
}): Tip[] {
  const { year, lots, report, dividends } = opts;
  const today = opts.today ?? todayIso();
  const rate = opts.taxRate ?? 0.15;
  const tips: Tip[] = [];
  const item = (l: LotView, note?: string): TipItem => ({
    lotId: l.id,
    instrumentId: l.instrumentId,
    name: l.name,
    acqDate: l.acqDate,
    qty: l.qty,
    timeTestDate: l.timeTestDate,
    valueCzk: l.valueCzk,
    gainCzk: l.taxGainCzk,
    note,
  });
  const open = lots.filter((l) => !l.timeTestPassed && l.taxGainCzk != null);

  // 1) Tax-loss harvesting
  const taxableGain = report.smallSalesExempt ? 0 : report.taxable.resultCzk;
  const losers = open.filter((l) => (l.taxGainCzk ?? 0) < 0).sort((a, b) => (a.taxGainCzk ?? 0) - (b.taxGainCzk ?? 0));
  if (taxableGain > 0 && losers.length) {
    let acc = 0;
    const chosen: LotView[] = [];
    for (const l of losers) {
      if (acc >= taxableGain) break;
      chosen.push(l);
      acc += -(l.taxGainCzk ?? 0);
    }
    const usable = Math.min(acc, taxableGain);
    tips.push({
      id: 'harvest',
      severity: 'warning',
      title: `Realizace ztrát do konce roku ${year}`,
      text: `Letos máte zdanitelný zisk z prodeje CP ${fmt(taxableGain)}. Prodejem ztrátových lotů (bez splněného časového testu) do 31. 12. můžete základ snížit až o ${fmt(usable)} a ušetřit cca ${fmt(usable * rate)} daně. V ČR neplatí pravidlo „wash sale“ – pozici lze hned znovu nakoupit (časový test ale začne běžet znovu).`,
      amountCzk: usable * rate,
      items: chosen.map((l) => item(l)),
    });
  } else if (losers.length && taxableGain <= 0) {
    tips.push({
      id: 'harvest-none',
      severity: 'info',
      title: 'Realizace ztrát letos nepřinese úsporu',
      text: `Letošní zdanitelný výsledek z prodeje CP je ${fmt(report.taxable.resultCzk)}${report.smallSalesExempt ? ' (příjmy jsou zatím v limitu 100 000 Kč)' : ''}. Ztrátu nelze převést do dalších let, takže prodej ztrátových pozic teď daňově nepomůže.`,
    });
  }

  // 2) 100k small-sales headroom
  if (report.limitProceedsCzk <= SMALL_SALES_LIMIT) {
    const room = SMALL_SALES_LIMIT - report.limitProceedsCzk;
    const winners = open.filter((l) => (l.taxGainCzk ?? 0) > 0 && (l.valueCzk ?? Infinity) <= room).sort((a, b) => (b.taxGainCzk ?? 0) / (b.valueCzk ?? 1) - (a.taxGainCzk ?? 0) / (a.valueCzk ?? 1));
    tips.push({
      id: 'small-sales',
      severity: 'success',
      title: `Volný limit 100 000 Kč: ${fmt(room)}`,
      text: `Úhrn příjmů z prodeje CP bez časového testu je letos ${fmt(report.limitProceedsCzk)}. Dokud celkové příjmy (ne zisk!) nepřesáhnou 100 000 Kč, jsou všechny tyto prodeje osvobozené. Hodí se to k realizaci zisku nebo rebalancování. Pozor – překročení limitu i o 1 Kč zdaní všechny prodeje v roce.`,
      amountCzk: room,
      items: winners.slice(0, 15).map((l) => item(l)),
    });
  } else {
    tips.push({
      id: 'small-sales-over',
      severity: 'info',
      title: 'Limit 100 000 Kč je letos překročen',
      text: `Příjmy z prodejů bez časového testu jsou ${fmt(report.limitProceedsCzk)}. Všechny tyto prodeje se letos daní; další prodeje se ziskem zvýší daň, se ztrátou ji sníží.`,
    });
  }

  // 3) Upcoming time tests with gains – wait before selling
  const horizon = addDays(today, 365);
  const soon = open.filter((l) => l.timeTestDate <= horizon && (l.taxGainCzk ?? 0) > 0).sort((a, b) => (a.timeTestDate < b.timeTestDate ? -1 : 1));
  if (soon.length) {
    const gain = soon.reduce((s, l) => s + (l.taxGainCzk ?? 0), 0);
    tips.push({
      id: 'time-test-soon',
      severity: 'info',
      title: 'Loty se ziskem, které brzy splní časový test',
      text: `${soon.length} lotů se ziskem ${fmt(gain)} splní časový test během 12 měsíců. Pokud je chcete prodat, vyplatí se počkat – po splnění testu je zisk osvobozený (úspora cca ${fmt(gain * rate)}).`,
      amountCzk: gain * rate,
      items: soon.map((l) => item(l)),
    });
  }

  // 4) Losses that will become unusable after the time test
  const lossSoon = open.filter((l) => l.timeTestDate <= horizon && (l.taxGainCzk ?? 0) < 0).sort((a, b) => (a.timeTestDate < b.timeTestDate ? -1 : 1));
  if (lossSoon.length) {
    const loss = -lossSoon.reduce((s, l) => s + (l.taxGainCzk ?? 0), 0);
    tips.push({
      id: 'loss-before-test',
      severity: 'warning',
      title: 'Ztrátové loty před splněním časového testu',
      text: `${lossSoon.length} lotů ve ztrátě ${fmt(loss)} brzy splní časový test. Po něm bude případná ztráta z prodeje daňově nevyužitelná. Pokud máte v daném roce zdanitelné zisky, zvažte prodej (a případný zpětný nákup) před datem splnění testu.`,
      amountCzk: loss,
      items: lossSoon.map((l) => item(l, `test ${l.timeTestDate}`)),
    });
  }

  // 5) Time-tested positions
  const tested = lots.filter((l) => l.timeTestPassed);
  if (tested.length) {
    const gain = tested.reduce((s, l) => s + Math.max(0, l.taxGainCzk ?? 0), 0);
    tips.push({
      id: 'time-tested',
      severity: 'success',
      title: 'Pozice se splněným časovým testem',
      text: `${tested.length} lotů již splnilo časový test – jejich prodej je osvobozen (nerealizovaný zisk ${fmt(gain)}). Při FIFO se prodávají nejstarší kusy jako první, takže dílčí prodej sáhne nejdřív na ně. Od roku 2025 platí limit osvobození 40 mil. Kč ročně.`,
      amountCzk: gain,
      items: tested.map((l) => item(l)),
    });
  }

  // 6) Dividend withholding reclaim
  const reclaim = new Map<string, number>();
  for (const d of dividends) if (d.reclaimableCzk > 1) reclaim.set(d.country, (reclaim.get(d.country) ?? 0) + d.reclaimableCzk);
  if (reclaim.size) {
    const total = [...reclaim.values()].reduce((a, b) => a + b, 0);
    tips.push({
      id: 'reclaim',
      severity: 'info',
      title: 'Přeplacená zahraniční srážková daň',
      text: `Z dividend bylo sraženo více, než umožňují smlouvy o zamezení dvojího zdanění – celkem ${fmt(total)} (${[...reclaim]
        .sort((a, b) => b[1] - a[1])
        .map(([c, v]) => `${countryName(c)} ${fmt(v)}`)
        .join(', ')}). Tento rozdíl nelze započíst v ČR; lze o něj žádat zahraniční správce daně (obvykle lhůta 2–5 let, nutné potvrzení o daňovém domicilu). U malých částek se to často nevyplatí. Do budoucna zvažte ETF s domicilem v Irsku.`,
      amountCzk: total,
    });
  }

  // 7) Unified vs daily FX
  for (const c of opts.fxComparison) {
    const diff = c.unifiedBaseCzk + c.unifiedDividendBaseCzk - (c.dailyBaseCzk + c.dailyDividendBaseCzk);
    if (Math.abs(diff) < 1000) continue;
    const better = diff > 0 ? 'denní kurzy ČNB' : 'jednotný kurz';
    tips.push({
      id: `fx-${c.year}`,
      severity: 'info',
      title: `Kurz pro rok ${c.year}: výhodnější je ${better}`,
      text: `Základ daně (CP + zahraniční dividendy) vychází s jednotným kurzem ${fmt(c.unifiedBaseCzk + c.unifiedDividendBaseCzk)} a s denními kurzy ${fmt(c.dailyBaseCzk + c.dailyDividendBaseCzk)}. Metodu lze zvolit pro každý rok zvlášť (v rámci roku jednotně) v Nastavení. Pozor: výdaje se přepočítávají kurzem roku nákupu, výsledek je proto orientační.`,
      amountCzk: Math.abs(diff) * rate,
    });
  }

  return tips;
}
