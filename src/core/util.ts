/** Parses numbers like "1700,66", "-1 234,5", "1.234,56" or "1234.56". Returns NaN for empty input. */
export function parseNum(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return NaN;
  if (typeof input === 'number') return input;
  let s = input.trim().replace(/[\s\u00a0]/g, '');
  if (!s) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // the later separator is the decimal one
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  return Number(s);
}

/** "dd-mm-yyyy" -> "yyyy-mm-dd" */
export function dmyToIso(d: string): string {
  const m = /^(\d{2})[-.\/](\d{2})[-.\/](\d{4})$/.exec(d.trim());
  if (!m) throw new Error(`Neplatné datum: ${d}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function isoDateUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function isoDateTimeUtc(d: Date): string {
  return `${isoDateUtc(d)}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function yearOf(isoDate: string): number {
  return Number(isoDate.slice(0, 4));
}

/** Adds whole years to an ISO date; 29 Feb maps to 28 Feb in non-leap years. */
export function addYears(iso: string, years: number): string {
  const y = Number(iso.slice(0, 4)) + years;
  const m = Number(iso.slice(5, 7));
  let d = Number(iso.slice(8, 10));
  if (m === 2 && d === 29 && !isLeap(y)) d = 28;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function addDays(iso: string, days: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return isoDateUtc(new Date(t + days * 86400000));
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)));
  const b = Date.UTC(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)));
  return Math.round((b - a) / 86400000);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
}

export function sum<T>(items: readonly T[], fn: (x: T) => number): number {
  let s = 0;
  for (const it of items) s += fn(it);
  return s;
}

export function groupBy<T, K>(items: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Normalises GBX (pence) to GBP. */
export function normaliseCurrency(amount: number, currency: string): { amount: number; currency: string } {
  const c = currency.trim().toUpperCase();
  if (c === 'GBX' || currency === 'GBp') return { amount: amount / 100, currency: 'GBP' };
  return { amount, currency: c };
}

export function todayIso(): string {
  return isoDate(new Date());
}
