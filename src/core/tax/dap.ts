import type { DividendPayment, DividendYearReport } from './dividends.js';
import { marginalTax, type SecuritiesYearReport } from './securities.js';
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

const kc = (n: number) => Math.round(n);
const floor100 = (n: number) => Math.floor(Math.max(0, n) / 100) * 100;
const fmt = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

/** Sleva na poplatníka (§35ba/1/a) */
export function basicTaxCredit(year: number): number {
  return year <= 2020 ? 24_840 : year === 2021 ? 27_840 : 30_840;
}

/** Foreign tax that may be credited: withheld amount capped by the treaty rate */
function treatyCappedWithheld(p: DividendPayment): number {
  if (p.finalTaxed || p.treatyRate == null || p.grossCzk <= 0) return 0;
  return Math.max(0, Math.min(p.withheldCzk, p.grossCzk * p.treatyRate));
}

const foreignPayments = (div: DividendYearReport) => div.payments.filter((p) => !p.finalTaxed);

export interface Priloha4 {
  r401a: number;
  r406: number;
  r409: number;
  r410: number;
  r411: number;
  r412: number;
  r413: number;
  /** → ř. 74a */
  r414: number;
}

/** Příloha č. 4 – samostatný základ daně podle §16a (zahraniční dividendy, sazba 15 %) */
export function computePriloha4(div: DividendYearReport): Priloha4 {
  const ps = foreignPayments(div);
  const r401a = kc(ps.reduce((s, p) => s + p.grossCzk, 0));
  const credited = ps.filter((p) => treatyCappedWithheld(p) > 0);
  const r411 = kc(credited.reduce((s, p) => s + p.grossCzk, 0));
  const r412 = kc(credited.reduce((s, p) => s + treatyCappedWithheld(p), 0));
  const r406 = r401a;
  const r409 = floor100(r406);
  const r410 = kc(r409 * 0.15);
  const r413 = kc(Math.min(r412, r411 * 0.15));
  const r414 = Math.ceil(Math.max(0, r410 - r413));
  return { r401a, r406, r409, r410, r411, r412, r413, r414 };
}

export interface Priloha3Country {
  country: string;
  r321: number;
  r322: number;
  r323: number;
  r324: number;
  r325: number;
  r326: number;
  r327: number;
  reclaimableCzk: number;
  treatyRate: number | null;
}

export interface Priloha3 {
  /** ř. 42 – total general tax base used for the coefficient (estimate) */
  r42: number;
  /** ř. 57 – tax on the general base before credits (estimate) */
  r57: number;
  countries: Priloha3Country[];
  r328: number;
  r329: number;
  /** → ř. 58 */
  r330: number;
}

/** Příloha č. 3 – zápočet daně zaplacené v zahraničí (foreign dividends taxed in the general base) */
export function computePriloha3(div: DividendYearReport, generalBaseCzk: number, year: number): Priloha3 {
  const r42 = kc(Math.max(0, generalBaseCzk));
  const r57 = kc(marginalTax(floor100(r42), 0, year));
  const byC = new Map<string, DividendPayment[]>();
  for (const p of foreignPayments(div)) byC.set(p.country, [...(byC.get(p.country) ?? []), p]);
  const countries: Priloha3Country[] = [...byC]
    .map(([country, ps]) => {
      const r321 = kc(ps.reduce((s, p) => s + p.grossCzk, 0));
      const r322 = 0;
      const r323 = kc(ps.reduce((s, p) => s + treatyCappedWithheld(p), 0));
      const r324 = r42 > 0 ? Math.round(Math.min(100, Math.max(0, ((r321 - r322) / r42) * 100)) * 100) / 100 : 0;
      const r325 = kc((r57 * r324) / 100);
      const r326 = Math.min(r323, r325);
      return {
        country,
        r321,
        r322,
        r323,
        r324,
        r325,
        r326,
        r327: Math.max(0, r323 - r326),
        reclaimableCzk: kc(ps.reduce((s, p) => s + p.reclaimableCzk, 0)),
        treatyRate: ps[0].treatyRate,
      };
    })
    .filter((c) => c.r321 > 0)
    .sort((a, b) => b.r321 - a.r321);
  const r328 = countries.reduce((s, c) => s + c.r326, 0);
  const r329 = countries.reduce((s, c) => s + c.r327, 0);
  return { r42, r57, countries, r328, r329, r330: Math.max(0, r57 - r328) };
}

/** Příloha č. 2 – oddíl 2: ostatní příjmy podle §10 (prodej cenných papírů) */
export function dapSecurities(sec: SecuritiesYearReport): DapBlock {
  const t = sec.taxable;
  const title = 'Příloha č. 2 – oddíl 2: Ostatní příjmy podle § 10';
  if (t.count === 0 && sec.capExcessCzk === 0)
    return { title, description: 'V tomto roce nejsou žádné zdanitelné příjmy z prodeje cenných papírů – oddíl 2 se nevyplňuje.', fields: [] };
  const income = kc(t.incomeCzk);
  const expenses = kc(Math.min(t.expensesCzk, t.incomeCzk));
  const diff = income - expenses;
  return {
    title,
    description:
      'Do tabulky uveďte jeden řádek pro druh příjmu „D – prodej cenných papírů“ (všechny prodeje dohromady). Ztrátu nelze uplatnit – výdaje se uvádějí nejvýše do výše příjmů. Ř. 209 přeneste na ř. 40 základní části DAP.',
    fields: [
      { row: 'tab. sl. 1', label: 'Druh příjmu', value: 'D', note: 'prodej cenných papírů' },
      { row: 'tab. sl. 2', label: 'Příjmy', value: income },
      {
        row: 'tab. sl. 3',
        label: 'Výdaje',
        value: expenses,
        note: t.expensesCzk > t.incomeCzk ? `skutečné výdaje ${fmt(t.expensesCzk)} – ztráta ${fmt(t.expensesCzk - t.incomeCzk)} se neuplatňuje` : 'nabývací cena + poplatky za nákup a prodej',
      },
      { row: 'tab. sl. 4', label: 'Rozdíl', value: diff },
      { row: 'tab. sl. 5', label: 'Kód', value: 'z', note: 'příjmy ze zdrojů v zahraničí (zahraniční CP přes zahraničního brokera) – u českých emitentů ponechte prázdné' },
      { row: '207', label: 'Příjmy podle § 10 zákona', value: income },
      { row: '208', label: 'Výdaje podle § 10 zákona (max. do výše příjmů)', value: expenses },
      { row: '209', label: 'Dílčí základ daně § 10 (ř. 207 − ř. 208) → ř. 40', value: diff },
    ],
  };
}

export interface DividendDapOptions {
  use16a: boolean;
  /** ř. 42 estimate – total general tax base including investment income taxed in it */
  generalBaseCzk: number;
  /** §8 income without final withholding that goes to ř. 38 regardless of §16a (e.g. interest) */
  otherCapitalCzk: number;
}

/** Foreign dividends: Příloha č. 4 (§16a) or ř. 38 + Příloha č. 3 */
export function dapDividends(div: DividendYearReport, year: number, opts: DividendDapOptions): DapBlock[] {
  const blocks: DapBlock[] = [];
  const gross = div.foreign.grossCzk;
  const use16a = opts.use16a && year >= 2021;
  const row38 = opts.otherCapitalCzk + (use16a ? 0 : gross);

  if (gross <= 0 && row38 <= 0) return [{ title: 'Zahraniční dividendy', description: 'V tomto roce nejsou zahraniční dividendy ani jiné kapitálové příjmy k přiznání.', fields: [] }];

  if (use16a && gross > 0) {
    const p = computePriloha4(div);
    blocks.push({
      title: 'Příloha č. 4 – samostatný základ daně podle § 16a',
      description:
        'Zvolili jste zdanění zahraničních dividend v samostatném základu sazbou 15 % (volba platí pro všechny zahraniční dividendy a úroky v roce). Příloha č. 3 se pro tyto příjmy nevyplňuje. Ř. 414 přeneste na ř. 74a; ř. 75 = ř. 74 + ř. 74a.',
      fields: [
        { row: '401a', label: 'Příjmy podle § 8 ze zdrojů v zahraničí (hrubé dividendy)', value: p.r401a },
        { row: '406', label: 'Úhrn dílčích samostatných základů (ř. 401 + ř. 401a)', value: p.r406 },
        { row: '409', label: 'Součet dílčích základů zaokrouhlený na celá sta Kč dolů', value: p.r409 },
        { row: '410', label: 'Daň 15 % z ř. 409', value: p.r410 },
        { row: '411', label: 'Úhrn příjmů, u nichž se uplatní zápočet', value: p.r411 },
        { row: '412', label: 'Daň zaplacená v zahraničí z příjmů na ř. 411', value: p.r412, note: 'max. do výše smluvní sazby; doložte potvrzením / výpisem brokera' },
        { row: '413', label: 'Daň uznaná k zápočtu (max. 15 % z ř. 411)', value: p.r413 },
        { row: '414', label: 'Daň ze samostatného základu (ř. 410 − ř. 413) → ř. 74a', value: p.r414 },
      ],
    });
  }

  if (row38 > 0) {
    const parts = [!use16a && gross > 0 ? `zahraniční dividendy ${fmt(gross)}` : '', opts.otherCapitalCzk > 0 ? `úroky bez srážkové daně ${fmt(opts.otherCapitalCzk)}` : ''].filter(Boolean);
    blocks.push({
      title: 'Základní část DAP – 2. oddíl: příjmy z kapitálového majetku (§ 8)',
      description: !use16a && gross > 0 && year >= 2021 ? 'Zahraniční dividendy jsou zdaněny v obecném základu (bez volby § 16a) – zápočet zahraniční daně se uplatní v Příloze č. 3.' : undefined,
      fields: [{ row: '38', label: 'Dílčí základ daně z kapitálového majetku podle § 8', value: kc(row38), note: parts.join(' + ') }],
    });
  }

  if (!use16a && gross > 0) {
    const p3 = computePriloha3(div, opts.generalBaseCzk, year);
    p3.countries.forEach((c, i) => {
      blocks.push({
        title: `Příloha č. 3${i > 0 ? ' – samostatný list' : ''} – ${countryName(c.country)} (${c.country})`,
        description: `Zápočet daně zaplacené ve státě zdroje. Smluvní sazba ${c.treatyRate == null ? 'není (bez smlouvy – zápočet nelze)' : `${Math.round(c.treatyRate * 100)} %`}.`,
        fields: [
          { row: '321', label: 'Příjmy ze zdrojů v zahraničí (hrubé)', value: c.r321 },
          { row: '322', label: 'Výdaje', value: c.r322 },
          { row: '323', label: 'Daň zaplacená v zahraničí (max. dle smlouvy)', value: c.r323 },
          { row: '324', label: 'Koeficient zápočtu v % ((ř. 321 − ř. 322) / ř. 42 × 100)', value: c.r324, note: 'odhad – závisí na celkovém základu daně (ř. 42)' },
          { row: '325', label: 'Max. započitatelná daň (ř. 57 × ř. 324 / 100)', value: c.r325, note: 'odhad' },
          { row: '326', label: 'Daň uznaná k zápočtu', value: c.r326 },
          { row: '327', label: 'Daň neuznaná k zápočtu', value: c.r327 },
          ...(c.reclaimableCzk > 0 ? [{ row: '–', label: 'Sraženo nad smluvní sazbu (lze žádat vrácení v zahraničí, mimo DAP)', value: c.reclaimableCzk }] : []),
        ],
      });
    });
    blocks.push({
      title: 'Příloha č. 3 – úhrnné řádky',
      description: `Odhad vychází ze základu daně ř. 42 ≈ ${fmt(p3.r42)} (jiný základ dle Nastavení + investiční příjmy). Hodnoty dopočítejte podle skutečného ř. 42 a ř. 57 vašeho přiznání.`,
      fields: [
        { row: '328', label: 'Daň uznaná k zápočtu (úhrn ř. 326)', value: p3.r328 },
        { row: '329', label: 'Daň neuznaná k zápočtu (úhrn ř. 327)', value: p3.r329 },
        { row: '330', label: 'Vypočtená částka (ř. 57 − ř. 328) → ř. 58', value: p3.r330, note: `ř. 57 ≈ ${fmt(p3.r57)}` },
      ],
    });
  }
  return blocks;
}
