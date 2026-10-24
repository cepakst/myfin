// Pure helpers for DataGrid: sorting, full-text search and per-column value filters.

export interface GridColumnMeta<T> {
  accessor: string;
  /** Value used for sorting; defaults to the record property named by `accessor` */
  sortValue?: (r: T) => unknown;
  /** Text matched by the search box; defaults to the accessor value when it is a string */
  searchValue?: (r: T) => string | null | undefined;
  /** Value used by the column filter; defaults to String(accessor value) */
  filterValue?: (r: T) => string | null | undefined;
}

export type SortDirection = 'asc' | 'desc';

export const normalizeText = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export function getPath(r: unknown, path: string): unknown {
  let v: unknown = r;
  for (const k of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

const collator = new Intl.Collator('cs', { numeric: true, sensitivity: 'base' });

/** Ascending comparison; null/undefined/NaN always sort last regardless of direction (handled in sortRows). */
export function compareValues(x: unknown, y: unknown): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
  return collator.compare(String(x), String(y));
}

const isEmpty = (v: unknown) => v == null || (typeof v === 'number' && Number.isNaN(v));

export function sortRows<T>(rows: T[], col: GridColumnMeta<T> | undefined, direction: SortDirection): T[] {
  if (!col) return rows;
  const get = col.sortValue ?? ((r: T) => getPath(r, col.accessor));
  const dir = direction === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i, v: get(r) }))
    .sort((a, b) => {
      const ea = isEmpty(a.v);
      const eb = isEmpty(b.v);
      if (ea || eb) return ea === eb ? a.i - b.i : ea ? 1 : -1;
      return compareValues(a.v, b.v) * dir || a.i - b.i;
    })
    .map((x) => x.r);
}

function searchText<T>(r: T, cols: GridColumnMeta<T>[]): string {
  const parts: string[] = [];
  for (const c of cols) {
    const v = c.searchValue ? c.searchValue(r) : getPath(r, c.accessor);
    if (typeof v === 'string' && v) parts.push(v);
  }
  return normalizeText(parts.join(' '));
}

/** Every whitespace-separated token of the query must occur in the record's searchable text (case and diacritics insensitive). */
export function searchRows<T>(rows: T[], cols: GridColumnMeta<T>[], query: string): T[] {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return rows;
  return rows.filter((r) => {
    const t = searchText(r, cols);
    return tokens.every((k) => t.includes(k));
  });
}

export function filterValueOf<T>(r: T, col: GridColumnMeta<T>): string {
  const v = col.filterValue ? col.filterValue(r) : getPath(r, col.accessor);
  return v == null || v === '' ? '–' : String(v);
}

export function distinctValues<T>(rows: T[], col: GridColumnMeta<T>): string[] {
  return [...new Set(rows.map((r) => filterValueOf(r, col)))].sort(collator.compare);
}

/** Keeps rows whose value is among the selected values for every column with an active filter. */
export function filterRows<T>(rows: T[], cols: GridColumnMeta<T>[], filters: Record<string, string[]>): T[] {
  const active = cols.filter((c) => filters[c.accessor]?.length);
  if (!active.length) return rows;
  return rows.filter((r) => active.every((c) => filters[c.accessor].includes(filterValueOf(r, c))));
}
