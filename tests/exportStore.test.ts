import { describe, expect, it } from 'vitest';
import {
  effectiveCoverage,
  groupByYear,
  mergeRecords,
  multisetDiff,
  nextCoverage,
  normalizeRanges,
  planImport,
  rangeGaps,
  sortRecords,
  type ExportRecord,
} from '../src/core/exportStore.js';

const rec = (date: string, key: string, time = '10:00'): ExportRecord => ({ date, sortKey: `${date}T${time}`, key, rows: [[key]] });
const keys = (rs: ExportRecord[]) => rs.map((r) => r.key);

describe('ranges', () => {
  it('sorts, joins overlapping and adjacent ranges and drops inverted ones', () => {
    expect(
      normalizeRanges([
        { from: '2022-01-01', to: '2022-12-31' },
        { from: '2021-01-01', to: '2021-12-31' },
        { from: '2021-06-01', to: '2021-06-30' },
        { from: '2024-05-01', to: '2024-04-01' },
      ]),
    ).toEqual([{ from: '2021-01-01', to: '2022-12-31' }]);
  });

  it('keeps ranges separated by a day apart and reports the gap', () => {
    const rs = [
      { from: '2020-01-01', to: '2020-12-31' },
      { from: '2021-01-02', to: '2021-12-31' },
    ];
    expect(normalizeRanges(rs)).toHaveLength(2);
    expect(rangeGaps(rs)).toEqual([{ from: '2021-01-01', to: '2021-01-01' }]);
  });

  it('has no gaps for adjacent days', () => {
    expect(
      rangeGaps([
        { from: '2020-01-01', to: '2020-12-31' },
        { from: '2021-01-01', to: '2021-03-01' },
      ]),
    ).toEqual([]);
  });
});

describe('groupByYear / sortRecords', () => {
  it('groups by the year of the date', () => {
    const g = groupByYear([rec('2021-12-31', 'a'), rec('2022-01-01', 'b'), rec('2022-05-05', 'c')]);
    expect([...g.keys()]).toEqual([2021, 2022]);
    expect(g.get(2022)).toHaveLength(2);
  });

  it('sorts newest first and keeps the order of equal sort keys', () => {
    const s = sortRecords([rec('2022-01-01', 'a'), rec('2022-03-01', 'b'), rec('2022-01-01', 'c'), rec('2022-01-01', 'd', '11:00')]);
    expect(keys(s)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('multisetDiff', () => {
  it('is count-aware for identical rows', () => {
    const a = rec('2022-01-01', 'x');
    expect(multisetDiff([a, a], [a])).toEqual({ added: 0, removed: 1, same: 1 });
    expect(multisetDiff([a], [a, a, a])).toEqual({ added: 2, removed: 0, same: 1 });
    expect(multisetDiff([a, a], [a, a])).toEqual({ added: 0, removed: 0, same: 2 });
  });
  it('counts different rows both ways', () => {
    expect(multisetDiff([rec('2022-01-01', 'a')], [rec('2022-01-01', 'b')])).toEqual({ added: 1, removed: 1, same: 0 });
  });
});

describe('mergeRecords', () => {
  const stored = [rec('2021-05-01', 's1'), rec('2022-02-01', 's2'), rec('2022-06-01', 's3'), rec('2023-01-10', 's4')];
  const incoming = [rec('2022-06-01', 's3'), rec('2022-07-01', 'n1'), rec('2023-03-01', 'n2')];
  const range = { from: '2022-05-01', to: '2023-06-30' };
  const cov = [{ from: '2021-01-01', to: '2023-02-28' }];

  it('merge: export is authoritative inside its range, stored rows outside stay', () => {
    // s4 (2023-01-10) is inside the range and missing from the export -> removed
    expect(keys(mergeRecords(stored, incoming, range, 'merge', cov))).toEqual(['n2', 'n1', 's3', 's2', 's1']);
  });

  it('keepExisting: only incoming rows outside stored coverage are added', () => {
    expect(keys(mergeRecords(stored, incoming, range, 'keepExisting', cov))).toEqual(['n2', 's4', 's3', 's2', 's1']);
  });

  it('replaceAll: the export is the whole history', () => {
    expect(keys(mergeRecords(stored, incoming, range, 'replaceAll', cov))).toEqual(['n2', 'n1', 's3']);
  });

  it('keeps identical duplicate rows of the export', () => {
    const d = rec('2022-06-01', 'dup');
    expect(keys(mergeRecords([], [d, d], range, 'merge', []))).toEqual(['dup', 'dup']);
  });
});

describe('coverage', () => {
  it('nextCoverage joins for merge/keepExisting and resets for replaceAll', () => {
    const cov = [{ from: '2020-01-01', to: '2020-12-31' }];
    const r = { from: '2021-01-01', to: '2021-06-30' };
    expect(nextCoverage(cov, r, 'merge')).toEqual([{ from: '2020-01-01', to: '2021-06-30' }]);
    expect(nextCoverage(cov, r, 'keepExisting')).toEqual([{ from: '2020-01-01', to: '2021-06-30' }]);
    expect(nextCoverage(cov, r, 'replaceAll')).toEqual([r]);
  });

  it('effectiveCoverage uses the recorded value or the stored rows range', () => {
    const recs = [rec('2021-03-01', 'a'), rec('2022-04-01', 'b')];
    expect(effectiveCoverage([{ from: '2020-01-01', to: '2022-12-31' }], recs)).toEqual([{ from: '2020-01-01', to: '2022-12-31' }]);
    expect(effectiveCoverage(undefined, recs)).toEqual([{ from: '2021-03-01', to: '2022-04-01' }]);
    expect(effectiveCoverage([], recs)).toEqual([{ from: '2021-03-01', to: '2022-04-01' }]);
    expect(effectiveCoverage(undefined, [])).toEqual([]);
  });
});

describe('planImport', () => {
  const stored = [rec('2021-05-01', 's1'), rec('2022-02-01', 's2'), rec('2022-06-01', 's3'), rec('2022-06-01', 's3')];
  const cov = [{ from: '2021-01-01', to: '2022-12-31' }];

  it('new rows only: no conflict, not unchanged, per-year counts', () => {
    const p = planImport(stored, cov, [rec('2023-02-01', 'n1'), rec('2023-03-01', 'n2')], { from: '2023-01-01', to: '2023-12-31' });
    expect(p.conflict).toBe(false);
    expect(p.unchanged).toBe(false);
    expect(p.added).toBe(2);
    expect(p.removed).toBe(0);
    expect(p.years.map((y) => y.year)).toEqual([2021, 2022, 2023]);
    const y23 = p.years[2];
    expect(y23).toMatchObject({ stored: 0, incoming: 2, added: 2, removed: 0 });
    expect(y23.result).toEqual({ merge: 2, keepExisting: 2, replaceAll: 2 });
    expect(p.years[1].result).toEqual({ merge: 3, keepExisting: 3, replaceAll: 0 });
  });

  it('same export again is unchanged (including duplicates)', () => {
    const p = planImport(stored, cov, stored, { from: '2021-01-01', to: '2022-12-31' });
    expect(p).toMatchObject({ conflict: false, unchanged: true, added: 0, removed: 0 });
  });

  it('missing stored row in range is a conflict; outside the range it is not', () => {
    const inc = [rec('2022-06-01', 's3'), rec('2022-06-01', 's3')];
    const p = planImport(stored, cov, inc, { from: '2022-05-01', to: '2022-12-31' });
    expect(p.conflict).toBe(false); // s1, s2 are before the range
    const p2 = planImport(stored, cov, [rec('2022-06-01', 's3')], { from: '2022-05-01', to: '2022-12-31' });
    expect(p2.conflict).toBe(true); // one of the two identical rows is missing
    expect(p2.removed).toBe(1);
    const y22 = p2.years.find((y) => y.year === 2022)!;
    expect(y22.result.merge).toBe(2); // s2 + one s3
    expect(y22.result.keepExisting).toBe(3);
    expect(y22.result.replaceAll).toBe(1);
  });

  it('is not unchanged when the range extends beyond the stored coverage', () => {
    const p = planImport([rec('2021-05-01', 's1')], [{ from: '2021-01-01', to: '2021-12-31' }], [rec('2021-05-01', 's1')], { from: '2021-01-01', to: '2022-06-30' });
    expect(p.unchanged).toBe(false);
  });

  it('reports new gaps only', () => {
    const covWithGap = [
      { from: '2020-01-01', to: '2020-12-31' },
      { from: '2022-01-01', to: '2022-12-31' },
    ];
    const p = planImport([], covWithGap, [rec('2024-02-01', 'n')], { from: '2024-01-01', to: '2024-12-31' });
    expect(p.newGaps).toEqual([{ from: '2023-01-01', to: '2023-12-31' }]);
    const adjacent = planImport([], covWithGap, [rec('2023-02-01', 'n')], { from: '2023-01-01', to: '2023-12-31' });
    expect(adjacent.newGaps).toEqual([]);
    expect(planImport([], [], [rec('2024-02-01', 'n')], { from: '2024-01-01', to: '2024-12-31' }).newGaps).toEqual([]);
  });
});
