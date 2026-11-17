/**
 * Pure logic for storing broker exports split by year and for merging a newly imported export
 * into the stored data. Rows are compared by content (Degiro has no unique row key), conflicts
 * are resolved by the export's date range.
 */
import { addDays } from './util.js';

export interface DateRange {
  /** inclusive ISO date */
  from: string;
  /** inclusive ISO date */
  to: string;
}

/** One logical export row (Degiro: a row plus its continuation rows without a date). */
export interface ExportRecord {
  /** ISO date that decides the year folder and the range membership */
  date: string;
  /** sorts records within a file (newest first) */
  sortKey: string;
  /** normalised content used to compare records */
  key: string;
  rows: unknown[][];
}

export type ImportMode = 'merge' | 'keepExisting' | 'replaceAll';
export const IMPORT_MODES: ImportMode[] = ['merge', 'keepExisting', 'replaceAll'];

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function inRange(date: string, r: DateRange): boolean {
  return date >= r.from && date <= r.to;
}

export function inRanges(date: string, rs: readonly DateRange[]): boolean {
  return rs.some((r) => inRange(date, r));
}

/** Sorts and joins overlapping or adjacent ranges. */
export function normalizeRanges(rs: readonly DateRange[]): DateRange[] {
  const sorted = rs.filter((r) => r.from <= r.to).map((r) => ({ ...r })).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: DateRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= addDays(last.to, 1)) {
      if (r.to > last.to) last.to = r.to;
    } else out.push(r);
  }
  return out;
}

/** Periods between the covered ranges. */
export function rangeGaps(rs: readonly DateRange[]): DateRange[] {
  const n = normalizeRanges(rs);
  const gaps: DateRange[] = [];
  for (let i = 1; i < n.length; i++) gaps.push({ from: addDays(n[i - 1].to, 1), to: addDays(n[i].from, -1) });
  return gaps;
}

export function recordsRange(recs: readonly ExportRecord[]): DateRange | undefined {
  if (recs.length === 0) return undefined;
  let from = recs[0].date;
  let to = recs[0].date;
  for (const r of recs) {
    if (r.date < from) from = r.date;
    if (r.date > to) to = r.date;
  }
  return { from, to };
}

export function groupByYear<T extends { date: string }>(recs: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of recs) {
    const y = Number(r.date.slice(0, 4));
    const list = out.get(y);
    if (list) list.push(r);
    else out.set(y, [r]);
  }
  return out;
}

/** Newest first; records with the same sort key keep their relative order. */
export function sortRecords<T extends ExportRecord>(recs: readonly T[]): T[] {
  return recs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.sortKey === b.r.sortKey ? a.i - b.i : a.r.sortKey < b.r.sortKey ? 1 : -1))
    .map((x) => x.r);
}

/** Count-aware comparison: identical rows that occur twice must also occur twice on the other side. */
export function multisetDiff(before: readonly ExportRecord[], after: readonly ExportRecord[]): { added: number; removed: number; same: number } {
  const counts = new Map<string, number>();
  for (const r of before) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  let added = 0;
  let same = 0;
  for (const r of after) {
    const c = counts.get(r.key) ?? 0;
    if (c > 0) {
      counts.set(r.key, c - 1);
      same++;
    } else added++;
  }
  let removed = 0;
  for (const c of counts.values()) removed += c;
  return { added, removed, same };
}

/**
 * Combines stored records with an imported export.
 * - merge: inside the export's range the export is authoritative, outside it the stored rows stay.
 *   An export made of several statements (`periods`, e.g. a zip of monthly statements with a missing
 *   month) is authoritative only for the periods it covers.
 * - keepExisting: stored rows stay; from the export only rows outside the stored coverage are added.
 *   The first and last day of each covered range may be incomplete (an export made during the day),
 *   so on those days the export's rows missing in the stored data are added too (count-aware).
 * - replaceAll: the export becomes the whole history.
 */
export function mergeRecords<T extends ExportRecord>(
  stored: readonly T[],
  incoming: readonly T[],
  range: DateRange,
  mode: ImportMode,
  storedCoverage: readonly DateRange[],
  periods: readonly DateRange[] = [range],
): T[] {
  let out: T[];
  if (mode === 'replaceAll') out = [...incoming];
  else if (mode === 'keepExisting') {
    const edges = new Set(normalizeRanges(storedCoverage).flatMap((c) => [c.from, c.to]));
    const storedOnEdge = new Map<string, number>();
    for (const r of stored) if (edges.has(r.date)) storedOnEdge.set(`${r.date}\u0000${r.key}`, (storedOnEdge.get(`${r.date}\u0000${r.key}`) ?? 0) + 1);
    const extra = incoming.filter((r) => {
      if (!inRanges(r.date, storedCoverage)) return true;
      if (!edges.has(r.date)) return false;
      const k = `${r.date}\u0000${r.key}`;
      const c = storedOnEdge.get(k) ?? 0;
      if (c > 0) {
        storedOnEdge.set(k, c - 1);
        return false;
      }
      return true;
    });
    out = [...stored, ...extra];
  } else out = [...stored.filter((r) => !inRanges(r.date, periods)), ...incoming];
  return sortRecords(out);
}

export function nextCoverage(coverage: readonly DateRange[], range: DateRange, mode: ImportMode, periods: readonly DateRange[] = [range]): DateRange[] {
  return mode === 'replaceAll' ? normalizeRanges(periods) : normalizeRanges([...coverage, ...periods]);
}

/** Coverage of stored data when no coverage was recorded (e.g. year folders copied by hand). */
export function effectiveCoverage(recorded: readonly DateRange[] | undefined, stored: readonly ExportRecord[]): DateRange[] {
  if (recorded && recorded.length) return normalizeRanges(recorded);
  const r = recordsRange(stored);
  return r ? [r] : [];
}

export interface YearPlan {
  year: number;
  /** stored records in the whole year */
  stored: number;
  /** records of the export in that year */
  incoming: number;
  /** export rows missing in the stored data (within the export range) */
  added: number;
  /** stored rows missing in the export (within the export range) */
  removed: number;
  /** record count of the year after the import, per mode */
  result: Record<ImportMode, number>;
}

export interface ImportPlan {
  range: DateRange;
  storedCoverage: DateRange[];
  years: YearPlan[];
  added: number;
  removed: number;
  /** stored rows inside the export range differ from the export */
  conflict: boolean;
  /** the import does not change anything */
  unchanged: boolean;
  /** periods not covered by any export between stored data and this import */
  newGaps: DateRange[];
}

export function planImport(
  stored: readonly ExportRecord[],
  storedCoverage: readonly DateRange[],
  incoming: readonly ExportRecord[],
  range: DateRange,
  periods: readonly DateRange[] = [range],
): ImportPlan {
  const storedInRange = stored.filter((r) => inRanges(r.date, periods));
  const results = Object.fromEntries(IMPORT_MODES.map((m) => [m, groupByYear(mergeRecords(stored, incoming, range, m, storedCoverage, periods))])) as Record<
    ImportMode,
    Map<number, ExportRecord[]>
  >;
  const sByYear = groupByYear(stored);
  const sInByYear = groupByYear(storedInRange);
  const iByYear = groupByYear(incoming);
  const yearSet = new Set<number>([...sByYear.keys(), ...iByYear.keys()]);
  const years: YearPlan[] = [...yearSet]
    .sort((a, b) => a - b)
    .map((year) => {
      const d = multisetDiff(sInByYear.get(year) ?? [], iByYear.get(year) ?? []);
      return {
        year,
        stored: sByYear.get(year)?.length ?? 0,
        incoming: iByYear.get(year)?.length ?? 0,
        added: d.added,
        removed: d.removed,
        result: Object.fromEntries(IMPORT_MODES.map((m) => [m, results[m].get(year)?.length ?? 0])) as Record<ImportMode, number>,
      };
    });
  const added = years.reduce((s, y) => s + y.added, 0);
  const removed = years.reduce((s, y) => s + y.removed, 0);
  const oldGaps = rangeGaps(storedCoverage);
  // gaps between the periods of the export itself (a missing statement) are new gaps as well
  const newGaps = storedCoverage.length || periods.length > 1 ? rangeGaps([...storedCoverage, ...periods]).filter((g) => !oldGaps.some((o) => o.from === g.from && o.to === g.to)) : [];
  return {
    range,
    storedCoverage: normalizeRanges(storedCoverage),
    years,
    added,
    removed,
    conflict: removed > 0,
    unchanged: added === 0 && removed === 0 && periods.every((p) => normalizeRanges(storedCoverage).some((c) => c.from <= p.from && c.to >= p.to)),
    newGaps,
  };
}
