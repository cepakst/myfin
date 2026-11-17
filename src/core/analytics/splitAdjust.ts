/**
 * Split adjustment for displaying price history: prices and trades before a split are expressed in
 * today's shares (price divided, quantity multiplied by every later split ratio), as on charting
 * sites. Display only – FIFO, taxes and stored trades keep the actual traded values.
 */

/** A split effective on `date`: `ratio` new shares per old share (0.1 = a 1:10 reverse split). */
export interface Split {
  date: string;
  ratio: number;
}

/** Product of the ratios of splits after `date` (a price on the split date is already post-split). */
export function splitFactor(splits: readonly Split[], date: string): number {
  let f = 1;
  for (const s of splits) if (date < s.date) f *= s.ratio;
  return f;
}

/** Actual price on `date` -> price in today's shares. */
export function adjustPrice(splits: readonly Split[], date: string, price: number): number {
  return price / splitFactor(splits, date);
}

/** Actual quantity on `date` -> quantity in today's shares. */
export function adjustQuantity(splits: readonly Split[], date: string, qty: number): number {
  return qty * splitFactor(splits, date);
}

const ratioNum = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : r.toLocaleString('cs-CZ', { maximumFractionDigits: 3 });
};

/** "20:1" for a split, "1:10" for a reverse split. */
export function splitLabel(ratio: number): string {
  return ratio >= 1 ? `${ratioNum(ratio)}:1` : `1:${ratioNum(1 / ratio)}`;
}
