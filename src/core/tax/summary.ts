import { profileFor, SITUATION_LABELS, type Settings } from '../settings.js';
import type { DividendYearReport } from './dividends.js';
import { marginalTax, type SecuritiesYearReport } from './securities.js';

export interface TaxNote {
  severity: 'info' | 'warning' | 'error';
  text: string;
}

export interface YearTaxSummary {
  year: number;
  situation: string;
  situationLabel: string;
  /** §10 – sale of securities (Příloha č. 2) */
  securitiesIncomeCzk: number;
  securitiesExpensesCzk: number;
  securitiesBaseCzk: number;
  /** §8 – foreign dividends (gross) */
  foreignDividendsCzk: number;
  foreignTaxCreditCzk: number;
  /** §8 – interest & other capital income without final withholding */
  otherCapitalIncomeCzk: number;
  /** Other taxable income relevant for filing thresholds (gross §8 + §10 income) */
  thresholdIncomeCzk: number;
  estimatedTaxSecuritiesCzk: number;
  estimatedTaxDividendsCzk: number;
  estimatedTaxTotalCzk: number;
  mustFile: boolean | null;
  notes: TaxNote[];
}

const fmt = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

export function yearTaxSummary(settings: Settings, sec: SecuritiesYearReport, div: DividendYearReport, otherCapitalIncomeCzk: number): YearTaxSummary {
  const year = sec.year;
  const profile = profileFor(settings, year);
  const securitiesIncomeCzk = sec.taxable.incomeCzk;
  const securitiesBaseCzk = sec.taxable.baseCzk;
  const foreignDividendsCzk = div.foreign.grossCzk;
  const thresholdIncomeCzk = securitiesIncomeCzk + foreignDividendsCzk + otherCapitalIncomeCzk;
  const estSec = marginalTax(securitiesBaseCzk, profile.otherTaxBase ?? 0, year);
  const estDiv = div.foreign.dueCzk;
  const notes: TaxNote[] = [];
  let mustFile: boolean | null = null;

  switch (profile.situation) {
    case 'OSVC':
      mustFile = true;
      notes.push({ severity: 'info', text: 'Jako OSVČ podáváte přiznání vždy – příjmy z investic uveďte v Příloze č. 2 (§10) a dividendy v §8 / Příloze č. 3.' });
      break;
    case 'OSVC_PAUSAL':
      if (thresholdIncomeCzk > 50_000) {
        mustFile = true;
        notes.push({
          severity: 'error',
          text: `Ostatní zdanitelné příjmy (${fmt(thresholdIncomeCzk)}) přesahují 50 000 Kč – v roce ${year} nelze zůstat v paušálním režimu a je nutné podat daňové přiznání.`,
        });
      } else {
        mustFile = false;
        notes.push({ severity: 'info', text: `Ostatní zdanitelné příjmy (${fmt(thresholdIncomeCzk)}) nepřesahují 50 000 Kč – paušální režim zůstává zachován.` });
      }
      break;
    case 'EMPLOYEE':
      if (thresholdIncomeCzk > 20_000) {
        mustFile = true;
        notes.push({ severity: 'warning', text: `Jiné příjmy než ze zaměstnání (${fmt(thresholdIncomeCzk)}) přesahují 20 000 Kč – musíte podat daňové přiznání (roční zúčtování u zaměstnavatele nestačí).` });
      } else {
        mustFile = false;
        notes.push({ severity: 'info', text: `Jiné příjmy (${fmt(thresholdIncomeCzk)}) nepřesahují 20 000 Kč – při podepsaném prohlášení u jediného zaměstnavatele nemusíte podávat přiznání.` });
      }
      break;
    case 'NO_INCOME':
      if (thresholdIncomeCzk > 15_000) {
        mustFile = true;
        notes.push({ severity: 'warning', text: `Zdanitelné příjmy (${fmt(thresholdIncomeCzk)}) přesahují 15 000 Kč – musíte podat daňové přiznání.` });
      } else {
        mustFile = false;
        notes.push({ severity: 'info', text: `Zdanitelné příjmy (${fmt(thresholdIncomeCzk)}) nepřesahují 15 000 Kč – přiznání podávat nemusíte.` });
      }
      break;
  }

  if (sec.smallSalesExempt && sec.limitProceedsCzk > 0)
    notes.push({ severity: 'info', text: `Příjmy z prodeje CP bez časového testu (${fmt(sec.limitProceedsCzk)}) nepřesáhly 100 000 Kč – jsou osvobozeny a do přiznání se neuvádějí.` });
  if (!sec.smallSalesExempt && sec.taxable.resultCzk < 0)
    notes.push({ severity: 'info', text: `Prodeje CP skončily ztrátou ${fmt(-sec.taxable.resultCzk)}. Ztrátu nelze uplatnit proti jiným příjmům ani převést do dalších let – dílčí základ je 0 Kč.` });
  if (sec.timeTestProceedsCzk > 0)
    notes.push({ severity: 'info', text: `Prodeje se splněným časovým testem (${fmt(sec.timeTestProceedsCzk)}) jsou osvobozeny.${year >= 2025 && sec.timeTestProceedsCzk > 5_000_000 ? ' Osvobozené příjmy nad 5 mil. Kč je nutné oznámit správci daně.' : ''}` });
  if (sec.capExcessCzk > 0)
    notes.push({ severity: 'error', text: `Osvobozené příjmy přesahují limit 40 mil. Kč o ${fmt(sec.capExcessCzk)} – tato část se daní.` });
  if (div.domesticFinal.grossCzk > 0)
    notes.push({ severity: 'info', text: `České dividendy (${fmt(div.domesticFinal.grossCzk)}) jsou zdaněny srážkovou daní u zdroje a do přiznání se neuvádějí.` });

  return {
    year,
    situation: profile.situation,
    situationLabel: SITUATION_LABELS[profile.situation],
    securitiesIncomeCzk,
    securitiesExpensesCzk: sec.taxable.expensesCzk,
    securitiesBaseCzk,
    foreignDividendsCzk,
    foreignTaxCreditCzk: div.foreign.creditableCzk,
    otherCapitalIncomeCzk,
    thresholdIncomeCzk,
    estimatedTaxSecuritiesCzk: estSec,
    estimatedTaxDividendsCzk: estDiv,
    estimatedTaxTotalCzk: estSec + estDiv,
    mustFile,
    notes,
  };
}
