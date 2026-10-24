import { profileFor, SITUATION_LABELS, uses16a, type Settings } from '../settings.js';
import { basicTaxCredit, computePriloha3, computePriloha4 } from './dap.js';
import type { DividendYearReport } from './dividends.js';
import { EXEMPT_REPORTING_LIMIT, marginalTax, SMALL_SALES_LIMIT, type SecuritiesYearReport } from './securities.js';

export interface TaxNote {
  severity: 'info' | 'warning' | 'error';
  text: string;
}

export interface YearTaxSummary {
  year: number;
  situation: string;
  situationLabel: string;
  /** Foreign dividends taxed in the separate §16a base (Příloha č. 4) */
  use16a: boolean;
  /** §10 – sale of securities (Příloha č. 2) */
  securitiesIncomeCzk: number;
  securitiesExpensesCzk: number;
  securitiesBaseCzk: number;
  /** §8 – foreign dividends (gross) */
  foreignDividendsCzk: number;
  foreignTaxCreditCzk: number;
  /** §8 – interest & other capital income without final withholding */
  otherCapitalIncomeCzk: number;
  /** Taxable income relevant for filing thresholds (gross §8 + §10 income, excluding exempt and final-taxed) */
  thresholdIncomeCzk: number;
  /** Estimated row 42 – general tax base incl. the other base from Settings */
  generalBaseCzk: number;
  estimatedTaxSecuritiesCzk: number;
  estimatedTaxDividendsCzk: number;
  /** Dividend tax under both options (for comparison) */
  estimatedTaxDividends16aCzk: number;
  estimatedTaxDividendsGeneralCzk: number;
  estimatedTaxTotalCzk: number;
  mustFile: boolean | null;
  /** Explanation of the filing obligation for the selected situation */
  filingReason: string | null;
  notes: TaxNote[];
}

const fmt = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

export function yearTaxSummary(settings: Settings, sec: SecuritiesYearReport, div: DividendYearReport, otherCapitalIncomeCzk: number): YearTaxSummary {
  const year = sec.year;
  const profile = profileFor(settings, year);
  const use16a = uses16a(settings, year);
  const otherBase = Math.max(0, profile.otherTaxBase ?? 0);
  const securitiesIncomeCzk = sec.taxable.incomeCzk;
  const securitiesBaseCzk = sec.taxable.baseCzk;
  const foreignDividendsCzk = div.foreign.grossCzk;
  const thresholdIncomeCzk = securitiesIncomeCzk + foreignDividendsCzk + otherCapitalIncomeCzk;
  const noIncome = profile.situation === 'NO_INCOME';

  /** Additional tax in the general base caused by `invest` (with Příloha č. 3 credit if dividends are included) */
  const generalTax = (invest: number, withDividends: boolean): number => {
    const total = otherBase + invest;
    let tax = marginalTax(total, 0, year);
    if (withDividends && foreignDividendsCzk > 0) tax -= computePriloha3(div, total, year).r328;
    // without other income the basic personal tax credit is still available
    if (noIncome) return Math.max(0, tax - basicTaxCredit(year));
    return Math.max(0, tax - marginalTax(otherBase, 0, year));
  };
  const baseInvest = securitiesBaseCzk + otherCapitalIncomeCzk;
  const estSec = generalTax(baseInvest, false);
  const divGeneral = foreignDividendsCzk > 0 ? Math.max(0, generalTax(baseInvest + foreignDividendsCzk, true) - estSec) : 0;
  const div16a = year >= 2021 && foreignDividendsCzk > 0 ? computePriloha4(div).r414 : divGeneral;
  const estDiv = use16a ? div16a : divGeneral;
  const generalBaseCzk = otherBase + baseInvest + (use16a ? 0 : foreignDividendsCzk);

  const notes: TaxNote[] = [];
  let mustFile: boolean | null = null;
  const divWhere = use16a ? 'Příloze č. 4 (§16a)' : 'ř. 38 a Příloze č. 3';

  switch (profile.situation) {
    case 'OSVC':
      mustFile = true;
      notes.push({ severity: 'info', text: `Jako OSVČ podáváte přiznání vždy – prodeje CP uveďte v Příloze č. 2 (§10), zahraniční dividendy v ${divWhere}. Příjmy podle §8 a §10 nezakládají povinnost platit sociální ani zdravotní pojištění.` });
      break;
    case 'OSVC_PAUSAL':
      if (thresholdIncomeCzk > 50_000) {
        mustFile = true;
        notes.push({
          severity: 'error',
          text: `Příjmy podle §8–§10 (${fmt(thresholdIncomeCzk)}) přesahují 50 000 Kč – v roce ${year} nelze zůstat v paušálním režimu a je nutné podat daňové přiznání.`,
        });
      } else {
        mustFile = false;
        notes.push({ severity: 'info', text: `Příjmy podle §8–§10 (${fmt(thresholdIncomeCzk)}) nepřesahují 50 000 Kč – paušální režim zůstává zachován.` });
      }
      break;
    case 'EMPLOYEE':
      if (thresholdIncomeCzk > 20_000) {
        mustFile = true;
        notes.push({ severity: 'warning', text: `Jiné příjmy než ze zaměstnání (${fmt(thresholdIncomeCzk)}) přesahují 20 000 Kč – musíte podat daňové přiznání (roční zúčtování u zaměstnavatele nestačí). Zahraniční dividendy se do limitu počítají i při zdanění podle §16a.` });
      } else {
        mustFile = false;
        notes.push({ severity: 'info', text: `Jiné příjmy (${fmt(thresholdIncomeCzk)}) nepřesahují 20 000 Kč – při podepsaném prohlášení u jediného zaměstnavatele nemusíte podávat přiznání.` });
      }
      break;
    case 'NO_INCOME':
      if (thresholdIncomeCzk > 50_000) {
        mustFile = true;
        notes.push({ severity: 'warning', text: `Zdanitelné příjmy (${fmt(thresholdIncomeCzk)}) přesahují 50 000 Kč – musíte podat daňové přiznání (§38g). V obecném základu lze uplatnit slevu na poplatníka ${fmt(basicTaxCredit(year))}.` });
      } else {
        mustFile = false;
        notes.push({ severity: 'info', text: `Zdanitelné příjmy (${fmt(thresholdIncomeCzk)}) nepřesahují 50 000 Kč – přiznání podávat nemusíte. Osvobozené příjmy a příjmy zdaněné srážkovou daní se do limitu nepočítají.` });
      }
      break;
  }
  const filingReason = notes[0]?.text ?? null;

  if (sec.smallSalesExempt && sec.limitProceedsCzk > 0)
    notes.push({ severity: 'info', text: `Příjmy z prodeje CP bez časového testu (${fmt(sec.limitProceedsCzk)}) nepřesáhly ${fmt(SMALL_SALES_LIMIT)} – jsou osvobozeny (§4/1/t) a do přiznání se neuvádějí.` });
  if (!sec.smallSalesExempt && sec.taxable.resultCzk < 0)
    notes.push({ severity: 'info', text: `Prodeje CP skončily ztrátou ${fmt(-sec.taxable.resultCzk)}. Ztrátu nelze uplatnit proti jiným příjmům ani převést do dalších let – dílčí základ je 0 Kč.` });
  if (sec.timeTestProceedsCzk > 0)
    notes.push({ severity: 'info', text: `Prodeje se splněným časovým testem (${fmt(sec.timeTestProceedsCzk)}) jsou osvobozeny (§4/1/u).` });
  if (sec.largestExemptSaleCzk > EXEMPT_REPORTING_LIMIT)
    notes.push({
      severity: 'warning',
      text: `Osvobozený příjem z jednoho prodeje (${fmt(sec.largestExemptSaleCzk)}) přesahuje 5 mil. Kč – je nutné jej oznámit správci daně do lhůty pro podání přiznání (§38v), jinak hrozí pokuta až 15 % neoznámeného příjmu.`,
    });
  if (sec.capExcessCzk > 0)
    notes.push({ severity: 'error', text: `V roce 2025 platí limit osvobození 40 mil. Kč – osvobozené příjmy jej přesahují o ${fmt(sec.capExcessCzk)} a tato část (s poměrnými výdaji) se daní.` });
  if (div.domesticFinal.grossCzk > 0)
    notes.push({ severity: 'info', text: `České dividendy (${fmt(div.domesticFinal.grossCzk)}) jsou zdaněny srážkovou daní u zdroje a do přiznání se neuvádějí.` });
  if (year >= 2021 && foreignDividendsCzk > 0) {
    const diff = div16a - divGeneral;
    if (use16a && diff > 200)
      notes.push({
        severity: 'warning',
        text: `Bez volby §16a by daň ze zahraničních dividend činila odhadem ${fmt(divGeneral)} místo ${fmt(div16a)}${noIncome ? ' (v obecném základu je pokryje sleva na poplatníka)' : ''}. Volbu lze změnit v sekci Daně.`,
      });
    else if (!use16a && diff < -200)
      notes.push({ severity: 'warning', text: `Při volbě §16a (Příloha č. 4) by daň ze zahraničních dividend činila odhadem ${fmt(div16a)} místo ${fmt(divGeneral)}. Volbu lze změnit v sekci Daně.` });
  }

  return {
    year,
    situation: profile.situation,
    situationLabel: SITUATION_LABELS[profile.situation],
    use16a,
    securitiesIncomeCzk,
    securitiesExpensesCzk: sec.taxable.expensesCzk,
    securitiesBaseCzk,
    foreignDividendsCzk,
    foreignTaxCreditCzk: foreignDividendsCzk <= 0 ? 0 : use16a ? computePriloha4(div).r413 : computePriloha3(div, generalBaseCzk, year).r328,
    otherCapitalIncomeCzk,
    thresholdIncomeCzk,
    generalBaseCzk,
    estimatedTaxSecuritiesCzk: estSec,
    estimatedTaxDividendsCzk: estDiv,
    estimatedTaxDividends16aCzk: div16a,
    estimatedTaxDividendsGeneralCzk: divGeneral,
    estimatedTaxTotalCzk: estSec + estDiv,
    mustFile,
    filingReason,
    notes,
  };
}
