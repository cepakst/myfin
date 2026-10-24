import { describe, expect, it } from 'vitest';
import { marketStatus, missingMarketData } from '../src/web/marketStatus.js';

const inst = (p: Partial<Parameters<typeof marketStatus>[0]> & { id: string }) => ({ symbol: null, symbolSource: 'none', hasMarket: false, type: 'STOCK', ...p });

describe('marketStatus', () => {
  it('classifies instruments by symbol source and loaded data', () => {
    expect(marketStatus(inst({ id: 'a', symbol: 'AAPL', symbolSource: 'auto', hasMarket: true }))).toBe('AUTO');
    expect(marketStatus(inst({ id: 'b', symbol: 'X.ST', symbolSource: 'override', hasMarket: true }))).toBe('OVERRIDE');
    expect(marketStatus(inst({ id: 'c', symbol: 'BAD', symbolSource: 'override', hasMarket: false }))).toBe('OVERRIDE_FAILED');
    expect(marketStatus(inst({ id: 'd', symbolSource: 'disabled' }))).toBe('DISABLED');
    expect(marketStatus(inst({ id: 'e' }))).toBe('MISSING');
    expect(marketStatus(inst({ id: 'g', type: 'CFD' }))).toBe('NOT_NEEDED');
    // auto symbol found but price history could not be loaded
    expect(marketStatus(inst({ id: 'f', symbol: 'AAPL', symbolSource: 'auto', hasMarket: false }))).toBe('MISSING');
  });

  it('missingMarketData skips disabled instruments and CFDs', () => {
    const list = [
      inst({ id: 'missing' }),
      inst({ id: 'failed', symbol: 'BAD', symbolSource: 'override' }),
      inst({ id: 'disabled', symbolSource: 'disabled' }),
      inst({ id: 'cfd', type: 'CFD' }),
      inst({ id: 'ok', symbol: 'AAPL', symbolSource: 'auto', hasMarket: true }),
    ];
    expect(missingMarketData(list).map((i) => i.id)).toEqual(['missing', 'failed']);
  });
});
