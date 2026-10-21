import type { FxConfig } from './fx.js';

export type TaxSituation = 'EMPLOYEE' | 'OSVC' | 'OSVC_PAUSAL' | 'NO_INCOME';

export interface YearTaxProfile {
  situation: TaxSituation;
  /** Other tax base (employment, business) in CZK – used for the 15 % / 23 % bracket estimate */
  otherTaxBase?: number;
}

export interface Settings {
  exportsDir?: string;
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

export function profileFor(s: Settings, year: number): YearTaxProfile {
  return s.taxProfiles[year] ?? { situation: s.defaultSituation };
}

export const SITUATION_LABELS: Record<TaxSituation, string> = {
  EMPLOYEE: 'Zaměstnanec',
  OSVC: 'OSVČ (mimo paušální režim)',
  OSVC_PAUSAL: 'OSVČ v paušálním režimu',
  NO_INCOME: 'Bez jiných zdanitelných příjmů',
};
