export type MarketStatus = 'MISSING' | 'OVERRIDE_FAILED' | 'AUTO' | 'OVERRIDE' | 'DISABLED' | 'NOT_NEEDED';

interface InstLike {
  id: string;
  type?: string;
  symbol: string | null;
  symbolSource: string;
  hasMarket: boolean;
}

export const MARKET_STATUS_LABEL: Record<MarketStatus, string> = {
  MISSING: 'nenalezeno',
  OVERRIDE_FAILED: 'ruční symbol bez dat',
  AUTO: 'automaticky',
  OVERRIDE: 'ručně',
  DISABLED: 'nepoužívat',
  NOT_NEEDED: 'není potřeba (CFD)',
};

export const MARKET_STATUS_COLOR: Record<MarketStatus, string> = {
  MISSING: 'orange',
  OVERRIDE_FAILED: 'red',
  AUTO: 'teal',
  OVERRIDE: 'blue',
  DISABLED: 'gray',
  NOT_NEEDED: 'gray',
};

/** Problems first, then the working states */
export const MARKET_STATUS_ORDER: MarketStatus[] = ['OVERRIDE_FAILED', 'MISSING', 'DISABLED', 'OVERRIDE', 'AUTO', 'NOT_NEEDED'];

export function marketStatus(i: InstLike): MarketStatus {
  // CFD prices are never fetched (they are valued from broker data)
  if (i.type === 'CFD') return 'NOT_NEEDED';
  if (i.symbolSource === 'disabled') return 'DISABLED';
  if (i.hasMarket) return i.symbolSource === 'override' ? 'OVERRIDE' : 'AUTO';
  return i.symbolSource === 'override' && i.symbol ? 'OVERRIDE_FAILED' : 'MISSING';
}

/** Instruments without market data that the user did not deliberately disable */
export function missingMarketData<T extends InstLike>(instruments: T[]): T[] {
  return instruments.filter((i) => ['MISSING', 'OVERRIDE_FAILED'].includes(marketStatus(i)));
}
