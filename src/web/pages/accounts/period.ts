import type { AccountsSnapshot } from '../../api';

/** Period choices shared by the accounts pages: last 12 months, a calendar year, or everything. */
export const DEFAULT_PERIOD = '12m';

export const monthLabel = (m: string) => `${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

export function periodOptions(a: AccountsSnapshot) {
  const years = [...new Set(a.months.map((m) => m.month.slice(0, 4)))].sort().reverse();
  return [{ value: '12m', label: 'Posledních 12 měsíců' }, ...years.map((y) => ({ value: y, label: `Rok ${y}` })), { value: 'all', label: 'Celá historie' }];
}

/** Months (YYYY-MM) of the period, up to the current month. */
export function periodMonths(a: AccountsSnapshot, period: string): string[] {
  const today = a.today.slice(0, 7);
  const all = a.months.map((m) => m.month).filter((m) => m <= today);
  if (period === '12m') return all.slice(-12);
  if (period === 'all') return all;
  return all.filter((m) => m.startsWith(period));
}
