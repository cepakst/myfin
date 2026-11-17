/**
 * Net worth across modules: bank account balances + market value of the investment portfolio, at the
 * end of each month, and what moved it. Pure – the inputs come from the two snapshots.
 */

export interface NetWorthPoint {
  /** YYYY-MM */
  month: string;
  /** bank accounts at month end (CZK) */
  accounts: number;
  /** market value of the positions at month end (CZK) */
  investments: number;
  /** cumulative net invested capital at month end (CZK) */
  invested: number;
  total: number;
}

export interface NetWorthChange {
  /** month whose end is the starting point */
  from: string;
  to: string;
  start: number;
  end: number;
  change: number;
  /** income − expenses on the bank accounts in the months after `from` up to `to` */
  saved: number;
  /** change of (portfolio value − invested capital): price moves, FX and trading fees */
  marketGain: number;
  /** opening balances of accounts whose data start inside the period (not a real change of wealth) */
  newAccounts: number;
  /**
   * invested capital that did not come from the tracked bank accounts: Δinvested − money the bank
   * accounts sent to investments (negative = money sent to a broker and not invested yet)
   */
  investedElsewhere: number;
  /**
   * the rest: money moved to or from accounts the app does not know, cash held at brokers,
   * dividends, estimated balances
   */
  other: number;
}

function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/**
 * Month-end series. Accounts are 0 before their first month; the portfolio is 0 before its first day
 * and keeps its last known value after the last one. Months without data in between are filled.
 */
export function netWorthSeries(accountMonths: readonly { month: string; balance: number }[], portfolioDaily: readonly { date: string; value: number; invested: number }[]): NetWorthPoint[] {
  // accounts months are contiguous and 0 before the first data, so no extra fill is needed
  const acc = new Map(accountMonths.map((m) => [m.month, m.balance]));
  const port = new Map<string, { value: number; invested: number }>();
  for (const p of portfolioDaily) port.set(p.date.slice(0, 7), { value: p.value, invested: p.invested }); // last day of the month wins
  const keys = [...acc.keys(), ...port.keys()].sort();
  if (!keys.length) return [];
  const out: NetWorthPoint[] = [];
  let lastAcc = 0;
  let lastPort = { value: 0, invested: 0 };
  for (let m = keys[0]; m <= keys.at(-1)!; m = nextMonth(m)) {
    if (acc.has(m)) lastAcc = acc.get(m)!;
    if (port.has(m)) lastPort = port.get(m)!;
    out.push({ month: m, accounts: lastAcc, investments: lastPort.value, invested: lastPort.invested, total: lastAcc + lastPort.value });
  }
  return out;
}

/**
 * Change of the net worth over the last `months` months (from the end of the month `months` before
 * the last one to the last point), split into savings, market gain and the rest. With a shorter
 * history the first month is the starting point. Null when there are fewer than two points.
 */
export function netWorthChange(
  series: readonly NetWorthPoint[],
  flows: readonly { month: string; income: number; expense: number; invested?: number }[],
  months: number,
  openings: readonly AccountOpening[] = [],
): NetWorthChange | null {
  if (series.length < 2) return null;
  const end = series.at(-1)!;
  const start = series[Math.max(0, series.length - 1 - months)];
  const inWindow = (m: string) => m > start.month && m <= end.month;
  const saved = flows.filter((f) => inWindow(f.month)).reduce((s, f) => s + f.income - f.expense, 0);
  const marketGain = end.investments - end.invested - (start.investments - start.invested);
  const newAccounts = openings.filter((o) => inWindow(o.month)).reduce((s, o) => s + o.amount, 0);
  const fromBank = flows.filter((f) => inWindow(f.month)).reduce((s, f) => s + (f.invested ?? 0), 0);
  const investedElsewhere = end.invested - start.invested - fromBank;
  const change = end.total - start.total;
  return {
    from: start.month,
    to: end.month,
    start: start.total,
    end: end.total,
    change,
    saved,
    marketGain,
    newAccounts,
    investedElsewhere,
    other: change - saved - marketGain - newAccounts - investedElsewhere,
  };
}

export interface AccountOpening {
  /** first month with data of the account */
  month: string;
  /** balance just before the first movement (CZK) – it "appears" in the net worth in that month */
  amount: number;
}

/**
 * Opening balances of accounts: before its first month an account counts as 0, so its balance at the
 * start of that month would otherwise look like new wealth. The opening is the month-end balance
 * minus the account's movements in that month.
 */
export function accountOpenings(
  accounts: readonly { id: string; hidden?: boolean; firstDate?: string; monthly: readonly { month: string; balanceCzk: number | null }[] }[],
  txs: readonly { accountId: string; date: string; amountCzk: number | null }[],
): AccountOpening[] {
  const out: AccountOpening[] = [];
  for (const a of accounts) {
    if (a.hidden) continue;
    const firstNonZero = a.monthly.find((m) => (m.balanceCzk ?? 0) !== 0)?.month;
    const month = [firstNonZero, a.firstDate?.slice(0, 7)].filter((x): x is string => !!x).sort()[0];
    if (!month) continue;
    const end = a.monthly.find((m) => m.month === month)?.balanceCzk ?? 0;
    const moved = txs.filter((t) => t.accountId === a.id && t.date.startsWith(month)).reduce((s, t) => s + (t.amountCzk ?? 0), 0);
    const amount = end - moved;
    if (Math.abs(amount) >= 0.005) out.push({ month, amount });
  }
  return out;
}
