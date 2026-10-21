import type { DividendYearReport } from './dividends.js';
import type { SecuritiesYearReport } from './securities.js';
import { countryName } from './treaties.js';

export interface DapField {
  row: string;
  label: string;
  value: number | string;
  note?: string;
}

export interface DapBlock {
  title: string;
  description?: string;
  fields: DapField[];
}

/** Příloha č. 2 – ostatní příjmy podle §10 (prodej cenných papírů) */
export function dapSecurities(sec: SecuritiesYearReport): DapBlock {
  const t = sec.taxable;
  return {
    title: 'Příloha č. 2 – oddíl 2: Ostatní příjmy (§10)',
    description:
      t.count === 0 && sec.capExcessCzk === 0
        ? 'V tomto roce nejsou žádné zdanitelné příjmy z prodeje cenných papírů – řádky se nevyplňují.'
        : 'Řádek 207 – jeden řádek tabulky pro druh příjmu „prodej cenných papírů“. Ztráta se nevykazuje (rozdíl se uvede 0).',
    fields: [
      { row: '207 sl. 1', label: 'Druh příjmu', value: 'D', note: 'prodej cenných papírů' },
      { row: '207 sl. 2', label: 'Příjmy', value: t.incomeCzk },
      { row: '207 sl. 3', label: 'Výdaje', value: t.expensesCzk },
      { row: '207 sl. 4', label: 'Rozdíl (příjmy − výdaje)', value: Math.max(0, t.resultCzk), note: t.resultCzk < 0 ? `skutečná ztráta ${Math.round(t.resultCzk)} Kč – neuplatňuje se` : undefined },
      { row: '209', label: 'Dílčí základ daně §10 (→ ř. 40 DAP)', value: t.baseCzk },
    ],
  };
}

/** Foreign dividends – samostatný základ daně §16a + Příloha č. 3 (zápočet daně zaplacené v zahraničí) */
export function dapDividends(div: DividendYearReport, year: number): DapBlock[] {
  const blocks: DapBlock[] = [];
  if (div.foreign.grossCzk <= 0) return [{ title: 'Zahraniční dividendy', description: 'V tomto roce nejsou zahraniční dividendy k přiznání.', fields: [] }];
  if (year >= 2021) {
    blocks.push({
      title: 'Samostatný základ daně dle §16a (Příloha č. 3 – oddíl „Samostatný základ daně“)',
      description: 'Zahraniční dividendy se od roku 2021 zdaňují v samostatném základu sazbou 15 %.',
      fields: [
        { row: '§16a', label: 'Příjmy z dividend ze zahraničí (hrubé)', value: div.foreign.grossCzk },
        { row: '§16a', label: 'Daň 15 % ze samostatného základu', value: div.foreign.czTaxCzk },
        { row: '§16a', label: 'Započtená daň zaplacená v zahraničí', value: div.foreign.creditableCzk },
        { row: '§16a', label: 'Daň k doplacení po zápočtu', value: div.foreign.dueCzk },
      ],
    });
  } else {
    blocks.push({
      title: 'Příjmy z kapitálového majetku (§8) – ř. 38 DAP',
      fields: [{ row: '38', label: 'Dílčí základ daně §8 (hrubé zahraniční dividendy)', value: div.foreign.grossCzk }],
    });
  }
  for (const c of div.byCountry) {
    blocks.push({
      title: `Příloha č. 3 – ${countryName(c.country)} (${c.country})`,
      description: `Zápočet daně zaplacené ve státě zdroje – samostatná Příloha č. 3 pro každý stát. Smluvní sazba ${c.treatyRate == null ? 'bez smlouvy' : `${Math.round(c.treatyRate * 100)} %`}.`,
      fields: [
        { row: '321', label: 'Příjmy ze zdrojů v zahraničí (hrubé)', value: c.grossCzk },
        { row: '323', label: 'Daň zaplacená v zahraničí (sražená)', value: c.withheldCzk },
        { row: '–', label: 'Z toho započitatelná (max. dle smlouvy)', value: c.creditableCzk },
        { row: '–', label: 'Nezapočitatelná část (lze žádat vrácení v zahraničí)', value: c.reclaimableCzk },
      ],
    });
  }
  return blocks;
}
