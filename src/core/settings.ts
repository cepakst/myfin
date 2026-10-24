import type { FxConfig } from './fx.js';

export type TaxSituation = 'EMPLOYEE' | 'OSVC' | 'OSVC_PAUSAL' | 'NO_INCOME';

export interface YearTaxProfile {
  /** Missing = inherit defaultSituation */
  situation?: TaxSituation;
  /** Other tax base (employment, business) in CZK – used for the 15 % / 23 % bracket estimate */
  otherTaxBase?: number;
  /** Tax foreign dividends in the separate §16a base (Příloha č. 4); default true from 2021 */
  foreign16a?: boolean;
}

export interface Settings {
  exportsDir?: string;
  /** Show the bundled demo data instead of the user's exports (stored in the main settings file only) */
  demo?: boolean;
  fx: FxConfig;
  /** Tax profile per year; years not listed use `defaultSituation` */
  taxProfiles: Record<number, YearTaxProfile>;
  defaultSituation: TaxSituation;
  /** Manual Yahoo symbol overrides keyed by instrument id ('' = no market data) */
  symbolOverrides: Record<string, string>;
  /** Issuer country overrides (dividend source country) keyed by instrument id */
  countryOverrides: Record<string, string>;
  /** Treaty rate overrides keyed by country (fraction, e.g. 0.15) */
  treatyOverrides: Record<string, number>;
}

export function defaultSettings(): Settings {
  return {
    fx: { methodByYear: {}, unifiedOverrides: {} },
    taxProfiles: {},
    defaultSituation: 'OSVC',
    symbolOverrides: {},
    countryOverrides: {},
    treatyOverrides: {},
  };
}

export function mergeSettings(raw: Partial<Settings> | undefined): Settings {
  const d = defaultSettings();
  if (!raw) return d;
  return {
    ...d,
    ...raw,
    fx: { methodByYear: { ...(raw.fx?.methodByYear ?? {}) }, unifiedOverrides: { ...(raw.fx?.unifiedOverrides ?? {}) } },
    taxProfiles: { ...(raw.taxProfiles ?? {}) },
    symbolOverrides: { ...(raw.symbolOverrides ?? {}) },
    countryOverrides: { ...(raw.countryOverrides ?? {}) },
    treatyOverrides: { ...(raw.treatyOverrides ?? {}) },
  };
}

/** Effective profile of a year (situation resolved from the default when not set for the year) */
export function profileFor(s: Settings, year: number): YearTaxProfile & { situation: TaxSituation } {
  const p = s.taxProfiles[year] ?? {};
  return { ...p, situation: p.situation ?? s.defaultSituation };
}

/** §16a separate tax base exists from 2021 and is elective */
export function uses16a(s: Settings, year: number): boolean {
  return year >= 2021 && (profileFor(s, year).foreign16a ?? true);
}

/**
 * Copy of the settings with the given year's stored tax profile patched. Only explicitly set fields are stored,
 * so a year without its own situation keeps following `defaultSituation`; `undefined` values clear a field.
 */
export function withYearProfile(s: Settings, year: number, patch: Partial<YearTaxProfile>): Settings {
  const merged: YearTaxProfile = { ...s.taxProfiles[year], ...patch };
  const stored = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as YearTaxProfile;
  const taxProfiles = { ...s.taxProfiles };
  if (Object.keys(stored).length) taxProfiles[year] = stored;
  else delete taxProfiles[year];
  return { ...s, taxProfiles };
}

export const SITUATION_LABELS: Record<TaxSituation, string> = {
  EMPLOYEE: 'Zaměstnanec',
  OSVC: 'OSVČ (mimo paušální režim)',
  OSVC_PAUSAL: 'OSVČ v paušálním režimu',
  NO_INCOME: 'Bez jiných zdanitelných příjmů',
};
