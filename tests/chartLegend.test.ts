import { describe, expect, it } from 'vitest';
import { legendRows } from '../src/web/chartLegend.js';

// every character 10 px wide: an item is 30 px + 10 px per character, 8 px gap, 10 px padding
const w = (s: string) => s.length * 10;

describe('legendRows', () => {
  it('unknown width (not measured yet) or no items', () => {
    expect(legendRows(['a'], 0, w)).toBe(Infinity);
    expect(legendRows([], 500, w)).toBe(0);
  });
  it('items fitting one row', () => {
    // 3 items of 30 + 50 = 80 px + 8 px gaps = 256 px in 290 px available (300 - 10)
    expect(legendRows(['aaaaa', 'bbbbb', 'ccccc'], 300, w)).toBe(1);
    // the gap after the last item does not count: 3 × 80 + 2 × 8 = 256 fits exactly
    expect(legendRows(['aaaaa', 'bbbbb', 'ccccc'], 266, w)).toBe(1);
    expect(legendRows(['aaaaa', 'bbbbb', 'ccccc'], 265, w)).toBe(2);
  });
  it('wraps when the next item does not fit', () => {
    expect(legendRows(['aaaaa', 'bbbbb', 'ccccc', 'ddddd'], 300, w)).toBe(2);
    expect(legendRows(Array.from({ length: 10 }, () => 'aaaaa'), 300, w)).toBe(4);
  });
  it('an item wider than the row takes a row of its own', () => {
    expect(legendRows(['x'.repeat(40), 'a'], 300, w)).toBe(2);
  });
});
