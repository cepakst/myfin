/**
 * Withholding tax rates on portfolio dividends under Czech double-tax treaties
 * (fraction of gross dividend that may be taxed in the source country).
 * null = no treaty in force -> no credit.
 */
export const TREATY_DIVIDEND_RATES: Record<string, number | null> = {
  US: 0.15,
  CA: 0.15,
  GB: 0.15,
  IE: 0.15,
  DE: 0.15,
  FR: 0.10,
  NL: 0.10,
  BE: 0.15,
  LU: 0.10,
  AT: 0.10,
  CH: 0.15,
  ES: 0.15,
  IT: 0.15,
  PT: 0.15,
  DK: 0.15,
  SE: 0.10,
  NO: 0.15,
  FI: 0.15,
  PL: 0.05,
  SK: 0.15,
  HU: 0.15,
  JP: 0.15,
  KR: 0.10,
  TW: 0.10,
  CN: 0.10,
  HK: 0.05,
  SG: 0.05,
  AU: 0.15,
  IL: 0.15,
  KZ: 0.10,
  BR: 0.15,
  ZA: 0.15,
  IN: 0.10,
  MX: 0.10,
  BM: null,
  KY: null,
  JE: null,
  GG: null,
};

/** Known depositary receipts – dividend source country differs from the ISIN prefix */
export const ISSUER_COUNTRY_BY_ISIN: Record<string, string> = {
  US8740391003: 'TW', // TSMC ADR
  US7960508882: 'KR', // Samsung GDR
  US48581R2058: 'KZ', // Kaspi.kz ADR
};

export const CZ_DIVIDEND_RATE = 0.15;

/** How to reclaim tax withheld above the treaty rate, per source country */
export const RECLAIM_INFO: Record<string, string> = {
  US: 'Předem podepsat W-8BEN u brokera (sníží srážku na 15 %); zpětné vrácení je u USA prakticky nemožné.',
  DE: 'Žádost o vrácení online přes portál BZSt (Bundeszentralamt für Steuern).',
  FR: 'Formulář 5000 (potvrzení rezidence) + 5001 (žádost o vrácení).',
  BE: 'Formulář 276 Div-Aut.',
  CH: 'Formulář 70 (pro rezidenty ČR) u ESTV.',
  AT: 'Elektronická předběžná žádost a formulář ZS-RD1 u rakouské finanční správy.',
  NO: 'Žádost RF-1026 u Skatteetaten.',
  LU: 'Formulář 901bis.',
  KR: 'Formulář NTS (žádost o vrácení přeplatku srážkové daně).',
  JP: 'Formulář 11 (Application for Refund of the Overpaid Withholding Tax).',
  PL: 'Žádost o vrácení přeplatku (wniosek o stwierdzenie nadpłaty) s certifikátem rezidence.',
  PT: 'Formulář Modelo 21-RFI.',
  ES: 'Modelo 210 u Agencia Tributaria.',
  IE: 'Formulář V2A u Revenue (DWT refund).',
  CA: 'Formulář NR301 předem u brokera, případně NR7-R pro vrácení.',
  IT: 'Žádost o vrácení (Modulo per il rimborso) u Agenzia delle Entrate.',
  DK: 'Online žádost o vrácení u Skattestyrelsen (formulář 06.003).',
  FI: 'Formulář VK1 (žádost o vrácení srážkové daně).',
};

export function treatyRate(country: string, overrides: Record<string, number> = {}): number | null {
  if (country in overrides) return overrides[country];
  return country in TREATY_DIVIDEND_RATES ? TREATY_DIVIDEND_RATES[country] : 0.15;
}

export const COUNTRY_NAMES: Record<string, string> = {
  US: 'USA', CA: 'Kanada', GB: 'Velká Británie', IE: 'Irsko', DE: 'Německo', FR: 'Francie', NL: 'Nizozemsko',
  BE: 'Belgie', LU: 'Lucembursko', AT: 'Rakousko', CH: 'Švýcarsko', ES: 'Španělsko', IT: 'Itálie', PT: 'Portugalsko',
  DK: 'Dánsko', SE: 'Švédsko', NO: 'Norsko', FI: 'Finsko', PL: 'Polsko', SK: 'Slovensko', HU: 'Maďarsko', JP: 'Japonsko',
  KR: 'Jižní Korea', TW: 'Tchaj-wan', CN: 'Čína', HK: 'Hongkong', SG: 'Singapur', AU: 'Austrálie', IL: 'Izrael',
  KZ: 'Kazachstán', BR: 'Brazílie', ZA: 'Jihoafrická republika', IN: 'Indie', MX: 'Mexiko', CZ: 'Česko',
  BM: 'Bermudy', KY: 'Kajmanské ostrovy', JE: 'Jersey', GG: 'Guernsey',
};

export function countryName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}
