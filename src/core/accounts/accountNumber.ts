/** Czech account number `[prefix-]number/bankcode` without leading zeros, or undefined. */
export function normAccount(raw: string | undefined): string | undefined {
  const m = /^\s*(?:(\d{1,6})\s*-\s*)?(\d{2,10})\s*\/\s*(\d{4})\s*$/.exec(raw ?? '');
  if (!m) return undefined;
  const prefix = (m[1] ?? '').replace(/^0+/, '');
  const number = m[2].replace(/^0+/, '');
  return `${prefix ? `${prefix}-` : ''}${number}/${m[3]}`;
}
