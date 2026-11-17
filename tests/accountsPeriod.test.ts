import { describe, expect, it } from 'vitest';
import type { AccountsSnapshot } from '../src/web/api.js';
import { DEFAULT_PERIOD, monthLabel, periodMonths, periodOptions } from '../src/web/pages/accounts/period.js';

/** Only `months` and `today` are used by the period helpers. */
function snap(months: string[], today: string): AccountsSnapshot {
  return { today, months: months.map((month) => ({ month })) } as unknown as AccountsSnapshot;
}

/** Consecutive months from..to (inclusive), YYYY-MM */
function range(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  while (`${y}-${String(m).padStart(2, '0')}` <= to) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

describe('periodMonths', () => {
  const a = snap(range('2023-06', '2026-03'), '2025-11-17');

  it('12m is the last 12 months up to the month of today', () => {
    const r = periodMonths(a, '12m');
    expect(r).toHaveLength(12);
    expect(r[0]).toBe('2024-12');
    expect(r.at(-1)).toBe('2025-11');
  });

  it('excludes months after today even when the snapshot has them', () => {
    expect(periodMonths(a, 'all').at(-1)).toBe('2025-11');
    expect(periodMonths(a, '2026')).toEqual([]);
  });

  it('a year keeps only that year, cut at today', () => {
    expect(periodMonths(a, '2024')).toEqual(range('2024-01', '2024-12'));
    expect(periodMonths(a, '2025')).toEqual(range('2025-01', '2025-11'));
  });

  it('all returns every month up to today', () => {
    expect(periodMonths(a, 'all')).toEqual(range('2023-06', '2025-11'));
  });

  it('12m returns fewer months when the history is shorter', () => {
    expect(periodMonths(snap(['2025-09', '2025-10'], '2025-11-01'), '12m')).toEqual(['2025-09', '2025-10']);
  });

  it('is empty without data and for an unknown year', () => {
    expect(periodMonths(snap([], '2025-11-17'), '12m')).toEqual([]);
    expect(periodMonths(a, '1999')).toEqual([]);
  });

  it('today at the start or end of the month stays in the same month', () => {
    const months = ['2025-10', '2025-11', '2025-12'];
    expect(periodMonths(snap(months, '2025-11-01'), 'all').at(-1)).toBe('2025-11');
    expect(periodMonths(snap(months, '2025-11-30'), 'all').at(-1)).toBe('2025-11');
  });
});

describe('periodOptions', () => {
  it('lists 12m first, years newest first, then all', () => {
    const o = periodOptions(snap(range('2023-11', '2025-02'), '2025-03-01'));
    expect(o.map((x) => x.value)).toEqual(['12m', '2025', '2024', '2023', 'all']);
    expect(o[0]).toEqual({ value: DEFAULT_PERIOD, label: 'Posledních 12 měsíců' });
    expect(o.find((x) => x.value === '2024')!.label).toBe('Rok 2024');
    expect(o.at(-1)!.label).toBe('Celá historie');
  });

  it('has only the fixed choices without data', () => {
    expect(periodOptions(snap([], '2025-01-01')).map((x) => x.value)).toEqual(['12m', 'all']);
  });
});

describe('monthLabel', () => {
  it('formats without a leading zero', () => {
    expect(monthLabel('2025-01')).toBe('1/2025');
    expect(monthLabel('2025-12')).toBe('12/2025');
  });
});
