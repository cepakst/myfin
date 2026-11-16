import type { BalancePoint } from './types.js';

/** Union by date; `incoming` wins on the same day. */
export function mergeBalances(stored: readonly BalancePoint[], incoming: readonly BalancePoint[]): BalancePoint[] {
  const m = new Map<string, number>();
  for (const p of stored) m.set(p.date, p.balance);
  for (const p of incoming) m.set(p.date, p.balance);
  return [...m].map(([date, balance]) => ({ date, balance })).sort((a, b) => (a.date < b.date ? -1 : 1));
}
