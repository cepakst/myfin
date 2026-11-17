import { describe, expect, it } from 'vitest';
import { adjustPrice, adjustQuantity, splitFactor, splitLabel, type Split } from '../src/core/analytics/splitAdjust.js';

const amzn: Split[] = [{ date: '2022-06-06', ratio: 20 }];

describe('splitFactor', () => {
  it('is 1 without splits', () => {
    expect(splitFactor([], '2020-01-01')).toBe(1);
  });
  it('applies a split to dates before it', () => {
    expect(splitFactor(amzn, '2022-06-05')).toBe(20);
  });
  it('treats the split date itself as post-split', () => {
    expect(splitFactor(amzn, '2022-06-06')).toBe(1);
  });
  it('is 1 after the split', () => {
    expect(splitFactor(amzn, '2023-01-01')).toBe(1);
  });
  it('multiplies several splits cumulatively', () => {
    const s: Split[] = [
      { date: '2021-07-20', ratio: 4 },
      { date: '2024-06-10', ratio: 10 },
    ];
    expect(splitFactor(s, '2020-01-01')).toBe(40);
    expect(splitFactor(s, '2021-07-20')).toBe(10);
    expect(splitFactor(s, '2023-05-01')).toBe(10);
    expect(splitFactor(s, '2024-06-10')).toBe(1);
  });
  it('handles reverse splits', () => {
    const s: Split[] = [{ date: '2023-01-10', ratio: 0.1 }];
    expect(splitFactor(s, '2023-01-09')).toBeCloseTo(0.1, 12);
    expect(splitFactor(s, '2023-01-10')).toBe(1);
  });
});

describe('adjustPrice / adjustQuantity', () => {
  it('divides price and multiplies quantity before a split', () => {
    expect(adjustPrice(amzn, '2022-01-03', 3000)).toBe(150);
    expect(adjustQuantity(amzn, '2022-01-03', 2)).toBe(40);
  });
  it('leaves values on and after the split date', () => {
    expect(adjustPrice(amzn, '2022-06-06', 120)).toBe(120);
    expect(adjustQuantity(amzn, '2022-06-07', 5)).toBe(5);
  });
  it('leaves values unchanged without splits', () => {
    expect(adjustPrice([], '2020-01-01', 12.5)).toBe(12.5);
    expect(adjustQuantity([], '2020-01-01', 3)).toBe(3);
  });
  it('keeps sell quantities negative and reverse splits invert the effect', () => {
    expect(adjustQuantity(amzn, '2022-01-03', -2)).toBe(-40);
    const rev: Split[] = [{ date: '2023-01-10', ratio: 0.1 }];
    expect(adjustPrice(rev, '2023-01-01', 1)).toBeCloseTo(10, 9);
    expect(adjustQuantity(rev, '2023-01-01', 100)).toBeCloseTo(10, 9);
  });
  it('matches the example from the UI (4 ks za 314,35 -> 40 ks za 31,435)', () => {
    const s: Split[] = [{ date: '2022-06-06', ratio: 10 }];
    expect(adjustQuantity(s, '2022-01-01', 4)).toBe(40);
    expect(adjustPrice(s, '2022-01-01', 314.35)).toBeCloseTo(31.435, 9);
  });
});

describe('splitLabel', () => {
  it('formats integer splits', () => {
    expect(splitLabel(20)).toBe('20:1');
    expect(splitLabel(2)).toBe('2:1');
    expect(splitLabel(1)).toBe('1:1');
  });
  it('uses a Czech decimal comma', () => {
    expect(splitLabel(1.5)).toBe('1,5:1');
  });
  it('formats reverse splits', () => {
    expect(splitLabel(0.1)).toBe('1:10');
    expect(splitLabel(0.5)).toBe('1:2');
  });
  it('rounds non-integer reverse ratios to 3 decimals', () => {
    expect(splitLabel(8 / 9)).toBe('1:1,125');
  });
});
