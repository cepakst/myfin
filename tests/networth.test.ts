import { describe, expect, it } from 'vitest';
import { accountOpenings, netWorthChange, netWorthSeries, type NetWorthPoint } from '../src/core/networth.js';

const d = (date: string, value: number, invested = 0) => ({ date, value, invested });
const a = (month: string, balance: number) => ({ month, balance });
const months = (s: NetWorthPoint[]) => s.map((p) => p.month);

describe('netWorthSeries', () => {
  it('returns [] for empty inputs', () => {
    expect(netWorthSeries([], [])).toEqual([]);
  });

  it('accounts only: investments are 0, gaps are filled with the last balance', () => {
    const s = netWorthSeries([a('2025-01', 100), a('2025-04', 400)], []);
    expect(months(s)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04']);
    expect(s.map((p) => p.accounts)).toEqual([100, 100, 100, 400]);
    expect(s.every((p) => p.investments === 0 && p.invested === 0)).toBe(true);
    expect(s.map((p) => p.total)).toEqual([100, 100, 100, 400]);
  });

  it('investments only: accounts are 0, forward-filled after the last day', () => {
    const s = netWorthSeries([], [d('2025-01-15', 1000, 900), d('2025-02-10', 1200, 900)]);
    expect(months(s)).toEqual(['2025-01', '2025-02']);
    expect(s.map((p) => p.accounts)).toEqual([0, 0]);
    expect(s.map((p) => p.total)).toEqual([1000, 1200]);
    expect(s[1].invested).toBe(900);
  });

  it('the last daily point in a month wins', () => {
    const s = netWorthSeries([], [d('2025-03-01', 10, 1), d('2025-03-31', 30, 3), d('2025-03-15', 20, 2)]);
    // input order is chronological in practice; the last one given for the month wins
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ investments: 20, invested: 2 });
    const ordered = netWorthSeries([], [d('2025-03-01', 10, 1), d('2025-03-15', 20, 2), d('2025-03-31', 30, 3)]);
    expect(ordered[0]).toMatchObject({ investments: 30, invested: 3 });
  });

  it('portfolio starting later than accounts: 0 before its first day', () => {
    const s = netWorthSeries([a('2025-01', 100), a('2025-02', 110), a('2025-03', 120)], [d('2025-03-20', 500, 450)]);
    expect(s.map((p) => p.investments)).toEqual([0, 0, 500]);
    expect(s.map((p) => p.invested)).toEqual([0, 0, 450]);
    expect(s.map((p) => p.total)).toEqual([100, 110, 620]);
  });

  it('accounts starting later than the portfolio: 0 before their first month, last value kept after', () => {
    const s = netWorthSeries([a('2025-02', 100)], [d('2025-01-10', 500, 500), d('2025-04-10', 600, 500)]);
    expect(months(s)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04']);
    expect(s.map((p) => p.accounts)).toEqual([0, 100, 100, 100]);
    expect(s.map((p) => p.investments)).toEqual([500, 500, 500, 600]);
    expect(s.map((p) => p.total)).toEqual([500, 600, 600, 700]);
  });

  it('spans the union of both ranges and crosses a year boundary', () => {
    const s = netWorthSeries([a('2024-11', 10), a('2025-01', 30)], [d('2024-12-31', 5, 5)]);
    expect(months(s)).toEqual(['2024-11', '2024-12', '2025-01']);
    expect(s.map((p) => p.accounts)).toEqual([10, 10, 30]);
    expect(s.map((p) => p.investments)).toEqual([0, 5, 5]);
  });

  it('is contiguous over several years', () => {
    const s = netWorthSeries([a('2023-12', 1), a('2026-02', 2)], []);
    expect(s).toHaveLength(27);
    expect(s[0].month).toBe('2023-12');
    expect(s[1].month).toBe('2024-01');
    expect(s.at(-1)!.month).toBe('2026-02');
  });
});

describe('netWorthChange', () => {
  const series = netWorthSeries(
    [a('2025-01', 100), a('2025-02', 150), a('2025-03', 170), a('2025-04', 200)],
    [d('2025-01-31', 1000, 1000), d('2025-02-28', 1100, 1000), d('2025-03-31', 1500, 1200), d('2025-04-30', 1400, 1200)],
  );
  const flows = [
    { month: '2025-01', income: 1000, expense: 900 }, // +100, the `from` month for the longest window: excluded
    { month: '2025-02', income: 500, expense: 450 }, // +50
    { month: '2025-03', income: 400, expense: 380 }, // +20
    { month: '2025-04', income: 300, expense: 270 }, // +30
  ];

  it('returns null with fewer than two points', () => {
    expect(netWorthChange([], [], 12)).toBeNull();
    expect(netWorthChange(series.slice(0, 1), flows, 12)).toBeNull();
  });

  it('1 month: from the end of the previous month, flow of that month excluded', () => {
    const c = netWorthChange(series, flows, 1)!;
    expect(c).toMatchObject({ from: '2025-03', to: '2025-04', start: 1670, end: 1600, change: -70, saved: 30 });
    expect(c.marketGain).toBe(-100); // (1400-1200) - (1500-1200)
    expect(c.other).toBeCloseTo(c.change - c.saved - c.marketGain);
    expect(c.other).toBe(0);
  });

  it('12 months with a shorter history starts at the first point and excludes its flow', () => {
    const c = netWorthChange(series, flows, 12)!;
    expect(c.from).toBe('2025-01');
    expect(c.start).toBe(1100);
    expect(c.end).toBe(1600);
    expect(c.change).toBe(500);
    expect(c.saved).toBe(100); // 50 + 20 + 30, January excluded
    expect(c.marketGain).toBe(200); // (1400-1200) - (1000-1000)
    // invested 1000 -> 1200 with no bank flows marked as investment: funded elsewhere
    expect(c.investedElsewhere).toBe(200);
    expect(c.other).toBe(0);
    expect(c.saved + c.marketGain + c.investedElsewhere + c.other).toBeCloseTo(c.change);
  });

  it('a long history: flows before the window are excluded', () => {
    const long = netWorthSeries(Array.from({ length: 20 }, (_, i) => a(`${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 100 * (i + 1))), []);
    const lf = long.map((p) => ({ month: p.month, income: 10, expense: 0 }));
    const c = netWorthChange(long, lf, 12)!;
    expect(c.to).toBe('2025-08');
    expect(c.from).toBe('2024-08');
    expect(c.saved).toBe(120);
    expect(c.change).toBe(1200);
    expect(c.other).toBe(1080);
  });

  it('months = series length gives the whole history', () => {
    const c = netWorthChange(series, flows, series.length)!;
    expect(c.from).toBe('2025-01');
  });

  it('identity saved + marketGain + other = change', () => {
    for (const m of [1, 2, 3, 12]) {
      const c = netWorthChange(series, flows, m)!;
      expect(c.saved + c.marketGain + c.newAccounts + c.investedElsewhere + c.other).toBeCloseTo(c.change, 9);
    }
  });

  it('money sent from the bank to investments is not counted as invested elsewhere', () => {
    const withInv = flows.map((f) => (f.month === '2025-03' ? { ...f, invested: 150 } : f));
    const c = netWorthChange(series, withInv, 12)!;
    expect(c.investedElsewhere).toBe(200 - 150);
    expect(c.other).toBe(150);
    // money sent to a broker and not invested yet makes it negative
    const c2 = netWorthChange(series, flows.map((f) => (f.month === '2025-03' ? { ...f, invested: 500 } : f)), 12)!;
    expect(c2.investedElsewhere).toBe(-300);
  });

  it('missing flows count as 0', () => {
    const c = netWorthChange(series, [], 1)!;
    expect(c.saved).toBe(0);
  });
});

describe('netWorthChange with account openings', () => {
  const series = netWorthSeries([a('2025-01', 0), a('2025-02', 1000), a('2025-03', 1100)], []);
  const flows = [
    { month: '2025-02', income: 100, expense: 0 },
    { month: '2025-03', income: 100, expense: 0 },
  ];

  it('an account that appears in the window is not counted as "other"', () => {
    const c = netWorthChange(series, flows, 12, [{ month: '2025-02', amount: 900 }])!;
    expect(c).toMatchObject({ from: '2025-01', change: 1100, saved: 200, marketGain: 0, newAccounts: 900, other: 0 });
    expect(c.saved + c.marketGain + c.newAccounts + c.other).toBeCloseTo(c.change, 9);
  });

  it('openings in or before the from month and after the to month are excluded; defaults to none', () => {
    const c = netWorthChange(series, flows, 1, [{ month: '2025-02', amount: 900 }, { month: '2025-03', amount: 5 }, { month: '2025-04', amount: 7 }])!;
    expect(c.from).toBe('2025-02');
    expect(c.newAccounts).toBe(5);
    expect(c.other).toBe(100 - 100 - 5);
    expect(netWorthChange(series, flows, 12)!.newAccounts).toBe(0);
  });
});

describe('accountOpenings', () => {
  const monthly = [
    { month: '2025-01', balanceCzk: 0 },
    { month: '2025-02', balanceCzk: 1000 },
    { month: '2025-03', balanceCzk: 1300 },
  ];
  it('opening = month-end balance minus movements of that month, in the first non-zero month', () => {
    const o = accountOpenings([{ id: 'A', monthly }], [
      { accountId: 'A', date: '2025-02-10', amountCzk: 400 },
      { accountId: 'A', date: '2025-02-20', amountCzk: -100 },
      { accountId: 'A', date: '2025-03-05', amountCzk: 300 }, // other month
      { accountId: 'B', date: '2025-02-10', amountCzk: 999 }, // other account
    ]);
    expect(o).toEqual([{ month: '2025-02', amount: 700 }]);
  });
  it('uses the earlier of firstDate month and the first non-zero month', () => {
    const o = accountOpenings([{ id: 'A', firstDate: '2025-01-15', monthly }], [{ accountId: 'A', date: '2025-01-15', amountCzk: 0 }]);
    expect(o).toEqual([]); // January balance is 0 and nothing moved: opening 0 is omitted
    const o2 = accountOpenings([{ id: 'A', firstDate: '2025-01-15', monthly: [{ month: '2025-01', balanceCzk: 50 }, ...monthly.slice(1)] }], [{ accountId: 'A', date: '2025-01-15', amountCzk: 20 }]);
    expect(o2).toEqual([{ month: '2025-01', amount: 30 }]);
  });
  it('skips hidden accounts, null balances and openings below half a haléř', () => {
    expect(accountOpenings([{ id: 'A', hidden: true, monthly }], [])).toEqual([]);
    expect(accountOpenings([{ id: 'A', monthly: [{ month: '2025-01', balanceCzk: null }] }], [])).toEqual([]);
    expect(accountOpenings([{ id: 'A', monthly: [{ month: '2025-01', balanceCzk: 10 }] }], [{ accountId: 'A', date: '2025-01-02', amountCzk: 10.003 }])).toEqual([]);
  });
  it('an account with no data produces nothing', () => {
    expect(accountOpenings([{ id: 'A', monthly: [] }], [])).toEqual([]);
    expect(accountOpenings([], [])).toEqual([]);
  });
});
