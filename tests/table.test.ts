import { describe, expect, it } from 'vitest';
import { compareValues, distinctValues, filterRows, filterValueOf, getPath, normalizeText, searchRows, sortRows, type GridColumnMeta } from '../src/web/table.js';

interface Row {
  id: number;
  name: string;
  amount: number | null | undefined;
  info?: { country?: string | null };
}

const col = (accessor: string, extra: Partial<GridColumnMeta<Row>> = {}): GridColumnMeta<Row> => ({ accessor, ...extra });

describe('normalizeText', () => {
  it('strips diacritics and lowercases', () => {
    expect(normalizeText('Příliš ŽLUŤOUČKÝ Kůň')).toBe('prilis zlutoucky kun');
  });
});

describe('getPath', () => {
  it('reads nested paths and tolerates missing parts', () => {
    const r: Row = { id: 1, name: 'A', amount: 1, info: { country: 'US' } };
    expect(getPath(r, 'info.country')).toBe('US');
    expect(getPath(r, 'name')).toBe('A');
    expect(getPath({ info: null }, 'info.country')).toBeUndefined();
    expect(getPath(r, 'name.length.x')).toBeUndefined();
    expect(getPath(undefined, 'a')).toBeUndefined();
  });
});

describe('compareValues', () => {
  it('compares numbers numerically', () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues(10, 2)).toBeGreaterThan(0);
    expect(compareValues(3, 3)).toBe(0);
  });
  it('uses Czech collation, numeric strings and ignores case', () => {
    expect(compareValues('c', 'č')).toBeLessThan(0);
    expect(compareValues('č', 'd')).toBeLessThan(0);
    expect(compareValues('item2', 'item10')).toBeLessThan(0);
    expect(compareValues('abc', 'ABC')).toBe(0);
  });
  it('orders booleans false before true', () => {
    expect(compareValues(false, true)).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  const rows: Row[] = [
    { id: 1, name: 'b', amount: 5 },
    { id: 2, name: 'a', amount: null },
    { id: 3, name: 'c', amount: 10 },
    { id: 4, name: 'd', amount: undefined },
    { id: 5, name: 'e', amount: Number.NaN },
    { id: 6, name: 'f', amount: 1 },
  ];
  const ids = (r: Row[]) => r.map((x) => x.id);

  it('returns rows untouched without a column', () => {
    expect(sortRows(rows, undefined, 'asc')).toBe(rows);
  });
  it('puts null/undefined/NaN last ascending, keeping their original order', () => {
    expect(ids(sortRows(rows, col('amount'), 'asc'))).toEqual([6, 1, 3, 2, 4, 5]);
  });
  it('puts null/undefined/NaN last descending too', () => {
    expect(ids(sortRows(rows, col('amount'), 'desc'))).toEqual([3, 1, 6, 2, 4, 5]);
  });
  it('is stable for equal values in both directions', () => {
    const eq: Row[] = [1, 2, 3, 4].map((id) => ({ id, name: 'x', amount: 7 }));
    expect(ids(sortRows(eq, col('amount'), 'asc'))).toEqual([1, 2, 3, 4]);
    expect(ids(sortRows(eq, col('amount'), 'desc'))).toEqual([1, 2, 3, 4]);
  });
  it('sorts Czech strings with collation', () => {
    const r: Row[] = ['d', 'č', 'c', 'a'].map((name, i) => ({ id: i, name, amount: 0 }));
    expect(sortRows(r, col('name'), 'asc').map((x) => x.name)).toEqual(['a', 'c', 'č', 'd']);
  });
  it('uses sortValue when present and nested accessors otherwise', () => {
    expect(ids(sortRows(rows, col('x', { sortValue: (r) => -r.id }), 'asc'))).toEqual([6, 5, 4, 3, 2, 1]);
    const nested: Row[] = [
      { id: 1, name: '', amount: 0, info: { country: 'US' } },
      { id: 2, name: '', amount: 0, info: { country: null } },
      { id: 3, name: '', amount: 0, info: { country: 'CZ' } },
    ];
    expect(ids(sortRows(nested, col('info.country'), 'desc'))).toEqual([1, 3, 2]);
  });
  it('does not mutate the input', () => {
    const copy = [...rows];
    sortRows(rows, col('amount'), 'desc');
    expect(rows).toEqual(copy);
  });
});

describe('searchRows', () => {
  const rows: Row[] = [
    { id: 1, name: 'Česká spořitelna', amount: 1, info: { country: 'CZ' } },
    { id: 2, name: 'Acme Corp', amount: 2, info: { country: 'US' } },
    { id: 3, name: 'Beta Corp', amount: 3, info: { country: 'US' } },
  ];
  const cols = [col('name'), col('info.country'), col('amount')];

  it('returns all rows for an empty or blank query', () => {
    expect(searchRows(rows, cols, '')).toBe(rows);
    expect(searchRows(rows, cols, '   ')).toBe(rows);
  });
  it('ignores diacritics and case', () => {
    expect(searchRows(rows, cols, 'CESKA sporitelna').map((r) => r.id)).toEqual([1]);
    expect(searchRows(rows, cols, 'česká').map((r) => r.id)).toEqual([1]);
  });
  it('requires every token to match, across columns', () => {
    expect(searchRows(rows, cols, 'corp us').map((r) => r.id)).toEqual([2, 3]);
    expect(searchRows(rows, cols, 'acme us').map((r) => r.id)).toEqual([2]);
    expect(searchRows(rows, cols, 'acme cz')).toEqual([]);
  });
  it('does not search numeric accessor values', () => {
    expect(searchRows(rows, cols, '2')).toEqual([]);
  });
  it('uses searchValue when given and tolerates null', () => {
    const c = [col('amount', { searchValue: (r) => (r.id === 3 ? null : `n${r.amount}`) })];
    expect(searchRows(rows, c, 'n2').map((r) => r.id)).toEqual([2]);
    expect(searchRows(rows, c, 'n3')).toEqual([]);
  });
});

describe('filters', () => {
  const rows: Row[] = [
    { id: 1, name: 'A', amount: 1, info: { country: 'US' } },
    { id: 2, name: 'B', amount: 2, info: { country: 'CZ' } },
    { id: 3, name: 'A', amount: 3, info: { country: '' } },
    { id: 4, name: 'C', amount: 4 },
  ];
  const cName = col('name');
  const cCountry = col('info.country');

  it('filterValueOf maps empty values to an en dash', () => {
    expect(filterValueOf(rows[0], cCountry)).toBe('US');
    expect(filterValueOf(rows[2], cCountry)).toBe('–');
    expect(filterValueOf(rows[3], cCountry)).toBe('–');
    expect(filterValueOf(rows[0], col('amount'))).toBe('1');
    expect(filterValueOf(rows[0], col('x', { filterValue: () => null }))).toBe('–');
    expect(filterValueOf(rows[0], col('x', { filterValue: () => 'custom' }))).toBe('custom');
  });
  it('distinctValues are unique and collated', () => {
    expect(distinctValues(rows, cName)).toEqual(['A', 'B', 'C']);
    expect(distinctValues(rows, cCountry)).toEqual(['–', 'CZ', 'US']);
  });
  it('filterRows ignores empty filters', () => {
    expect(filterRows(rows, [cName, cCountry], {})).toBe(rows);
    expect(filterRows(rows, [cName, cCountry], { name: [] })).toBe(rows);
  });
  it('filterRows combines columns with AND and values with OR', () => {
    expect(filterRows(rows, [cName, cCountry], { name: ['A', 'B'] }).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(filterRows(rows, [cName, cCountry], { name: ['A', 'B'], 'info.country': ['US', '–'] }).map((r) => r.id)).toEqual([1, 3]);
    expect(filterRows(rows, [cName, cCountry], { 'info.country': ['–'] }).map((r) => r.id)).toEqual([3, 4]);
    expect(filterRows(rows, [cName, cCountry], { name: ['C'], 'info.country': ['US'] })).toEqual([]);
  });
});
