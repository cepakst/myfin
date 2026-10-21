const czkFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 4 });
const num2Fmt = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const czk = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '–' : `${czkFmt.format(Math.round(n))} Kč`);
export const czkRaw = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '' : String(Math.round(n)));
export const num = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '–' : numFmt.format(n));
export const num2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '–' : num2Fmt.format(n));
export const pct = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(n) ? '–' : `${(n * 100).toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
export const date = (iso: string | null | undefined) => {
  if (!iso) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
};
export const money = (n: number | null | undefined, cur: string | null | undefined) =>
  n == null || !Number.isFinite(n) ? '–' : `${num2Fmt.format(n)} ${cur ?? ''}`.trim();
export const signColor = (n: number | null | undefined) => (n == null || Math.abs(n) < 0.5 ? undefined : n > 0 ? 'teal' : 'red');

export const SITUATIONS = [
  { value: 'OSVC', label: 'OSVČ (mimo paušální režim)' },
  { value: 'OSVC_PAUSAL', label: 'OSVČ v paušálním režimu' },
  { value: 'EMPLOYEE', label: 'Zaměstnanec' },
  { value: 'NO_INCOME', label: 'Bez jiných zdanitelných příjmů' },
];
