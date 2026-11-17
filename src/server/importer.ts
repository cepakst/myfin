/**
 * Import of broker exports into the store (data/store), split by year:
 *   degiro/<year>/Transactions.csv, degiro/<year>/Account.csv
 *   xtb/<account>/<year>/<CCY>_<account>_<year>.xlsx, xtb/<account>/<CCY>_<account>_open-positions.xlsx
 *   banks/<bank>/<account>/<year>/transactions.csv, banks/<bank>/<account>/balances.csv (accounts module)
 *   banks/rb/<account>/<year>/statement-transactions.csv (movements from RB PDF statements),
 *   banks/rb/<account>/statements.csv (statement summaries), banks/rb/<account>/<year>/statements/*.pdf
 *   (copies of the imported PDF statements)
 * Imported periods are recorded in myfin-coverage.json, imported source files (by content hash) in
 * imports.json. Replaced store files and uploaded originals go to _archiv/<timestamp>/ in the store.
 * The user's exports folder is only read, never written.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  effectiveCoverage,
  groupByYear,
  IMPORT_MODES,
  isIsoDate,
  mergeRecords,
  multisetDiff,
  nextCoverage,
  normalizeRanges,
  planImport,
  rangeGaps,
  recordsRange,
  type DateRange,
  type ExportRecord,
  type ImportMode,
  type ImportPlan,
} from '../core/exportStore.js';
import {
  DEGIRO_FILE,
  degiroUnit,
  headerSignature,
  readDegiroTable,
  readXtbTables,
  writeCsv,
  writeXtbCashBook,
  writeXtbOpenPositionsBook,
  xtbOpenPositionsFileName,
  xtbYearFileName,
  type ExportTable,
} from '../core/exportTables.js';
import {
  BANK_MARKER,
  isBankKind,
  KIND_BANK,
  mergeBalances,
  readBalancesCsv,
  readBankTables,
  readStatementsCsv,
  statementKey,
  writeBalancesCsv,
  writeStatementsCsv,
} from '../core/accounts/bankTables.js';
import { NotRbStatementError } from '../core/accounts/rbPdf.js';
import { readRbPdfTables } from '../core/accounts/rbPdfTables.js';
import type { BalancePoint, StatementSummary } from '../core/accounts/types.js';
import { detectFileKind } from '../core/parsers/index.js';
import { addDays, daysBetween } from '../core/util.js';
import { classifyExportFiles, listExportFiles, relExportPath } from './store.js';

export const COVERAGE_FILE = 'myfin-coverage.json';

interface CoverageEntry {
  coverage: DateRange[];
  openPositionsAsOf?: string;
}
type CoverageDb = Record<string, CoverageEntry>;

type UnitRef = Pick<ExportTable, 'unit' | 'kind' | 'label' | 'account' | 'currency'>;

export class ImportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The file is not an export the app reads (e.g. another PDF in the exports folder); not retried. */
export class UnsupportedFileError extends ImportError {}

// --- serialisation of file system work (imports, snapshot reads) ---

let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

// --- helpers ---

export function czDate(iso: string): string {
  return `${Number(iso.slice(8, 10))}. ${Number(iso.slice(5, 7))}. ${iso.slice(0, 4)}`;
}

function loadCoverage(dir: string): CoverageDb {
  const p = join(dir, COVERAGE_FILE);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { units?: Record<string, { coverage?: unknown; openPositionsAsOf?: unknown }> };
    const out: CoverageDb = {};
    for (const [unit, e] of Object.entries(raw.units ?? {})) {
      const cov = Array.isArray(e.coverage) ? (e.coverage as DateRange[]).filter((r) => r && isIsoDate(r.from) && isIsoDate(r.to)) : [];
      out[unit] = { coverage: normalizeRanges(cov), openPositionsAsOf: typeof e.openPositionsAsOf === 'string' ? e.openPositionsAsOf : undefined };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export const BANK_YEAR_FILE = 'transactions.csv';
export const BANK_PDF_YEAR_FILE = 'statement-transactions.csv';
export const BANK_BALANCES_FILE = 'balances.csv';
export const BANK_STATEMENTS_FILE = 'statements.csv';

function unitRoot(dir: string, u: UnitRef): string {
  if (isBankKind(u.kind)) return join(dir, 'banks', KIND_BANK[u.kind].toLowerCase(), u.account ?? 'ucet');
  return u.kind === 'XTB' ? join(dir, 'xtb', u.account ?? 'ucet') : join(dir, 'degiro');
}

/** Year file name of a bank unit: the CSV export and the PDF statements of an account are kept apart. */
function bankYearFileName(kind: ExportTable['kind']): string {
  return kind === 'BANK_RB_PDF' ? BANK_PDF_YEAR_FILE : BANK_YEAR_FILE;
}

function yearFile(dir: string, u: UnitRef, year: number): string {
  const root = join(unitRoot(dir, u), String(year));
  if (isBankKind(u.kind)) return join(root, bankYearFileName(u.kind));
  return u.kind === 'XTB' ? join(root, xtbYearFileName(u.currency ?? 'CZK', u.account ?? 'ucet', year)) : join(root, DEGIRO_FILE[u.kind]);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Existing year files of a unit. */
function unitYearFiles(dir: string, u: UnitRef): Map<number, string> {
  const out = new Map<number, string>();
  const root = unitRoot(dir, u);
  if (!isDir(root)) return out;
  for (const y of readdirSync(root)) {
    if (!/^\d{4}$/.test(y) || !isDir(join(root, y))) continue;
    if (u.kind === 'XTB') {
      const f = readdirSync(join(root, y)).find((n) => /^[A-Z]{3}_[\w-]+_\d{4}\.xlsx$/.test(n));
      if (f) out.set(Number(y), join(root, y, f));
    } else if (isBankKind(u.kind)) {
      const p = join(root, y, bankYearFileName(u.kind));
      if (existsSync(p)) out.set(Number(y), p);
    } else {
      const p = join(root, y, DEGIRO_FILE[u.kind]);
      if (existsSync(p)) out.set(Number(y), p);
    }
  }
  return out;
}

interface StoredUnit {
  records: ExportRecord[];
  header?: unknown[][];
  yearFiles: Map<number, string>;
  /** year files that could not be read (e.g. re-saved by Excel in another format) */
  unreadable: { path: string; error: string }[];
}

async function readTableFile(path: string, u: UnitRef): Promise<ExportTable | undefined> {
  const data = readFileSync(path);
  if (u.kind === 'XTB') return (await readXtbTables(new Uint8Array(data), basename(path)))[0];
  if (isBankKind(u.kind)) return readBankTables(basename(path), new Uint8Array(data), u.kind)[0];
  return readDegiroTable(data.toString('utf-8'), u.kind);
}

async function loadStoredUnit(dir: string, u: UnitRef): Promise<StoredUnit> {
  const yearFiles = unitYearFiles(dir, u);
  const records: ExportRecord[] = [];
  let header: unknown[][] | undefined;
  const unreadable: StoredUnit['unreadable'] = [];
  for (const [, p] of [...yearFiles].sort((a, b) => a[0] - b[0])) {
    try {
      const t = await readTableFile(p, u);
      if (!t) continue;
      header ??= t.header;
      records.push(...t.records);
    } catch (e) {
      unreadable.push({ path: relExportPath(dir, p), error: (e as Error).message });
    }
  }
  return { records, header, yearFiles, unreadable };
}

export async function readExportTables(fileName: string, data: Uint8Array): Promise<ExportTable[]> {
  const kind = detectFileKind(fileName, data);
  if (kind === 'DEGIRO_TX' || kind === 'DEGIRO_ACCOUNT') return [readDegiroTable(new TextDecoder('utf-8').decode(data), kind)];
  if (kind === 'XTB') return readXtbTables(data, fileName);
  if (kind === 'BANK_RB_PDF') {
    try {
      return await readRbPdfTables(fileName, data);
    } catch (e) {
      if (e instanceof NotRbStatementError) throw new UnsupportedFileError(`${fileName}: ${e.message} Z PDF souborů aplikace čte jen výpisy z účtu Raiffeisenbank.`);
      throw new ImportError(`${fileName}: PDF se nepodařilo přečíst (${(e as Error).message}).`);
    }
  }
  if (isBankKind(kind)) {
    try {
      return readBankTables(fileName, data, kind);
    } catch (e) {
      throw new ImportError(`${fileName}: ${(e as Error).message}`);
    }
  }
  throw new ImportError(
    `Neznámý formát souboru ${fileName}. Podporované jsou Degiro Transactions.csv a Account.csv, export XTB (.zip nebo .xlsx), výpisy z účtu v CSV od Fio banky, Komerční banky a Raiffeisenbank a PDF výpisy Raiffeisenbank (i v zipu).`,
  );
}

// --- preview ---

export interface UnitPreview {
  unit: string;
  label: string;
  kind: ExportTable['kind'];
  /** first and last date of the export's rows */
  dataRange?: DateRange;
  /** period the export states (XTB) */
  declaredRange?: DateRange;
  /** period the export is authoritative for (defaults to declared or data range) */
  range: DateRange;
  rangeEditable: boolean;
  /** stored data exist for this unit */
  hasStored: boolean;
  plan: ImportPlan;
  allowedModes: ImportMode[];
  warnings: string[];
}

export interface ImportPreview {
  id: string;
  fileName: string;
  units: UnitPreview[];
  /** the user has to decide: stored rows would be removed or the formats differ */
  conflict: boolean;
}

type StageSource = { kind: 'upload' } | { kind: 'inbox'; inbox: string; path: string };

interface Staged {
  id: string;
  created: number;
  /** store dir the import is planned against */
  store: string;
  fileName: string;
  data: Buffer;
  hash: string;
  source: StageSource;
  tables: ExportTable[];
}

const STAGE_TTL_MS = 60 * 60 * 1000;
const staged = new Map<string, Staged>();

const MAX_STAGED = 5;
// abandoned previews (e.g. the page was closed with the dialog open) are dropped after the TTL
setInterval(() => purgeStaged(false), 5 * 60 * 1000).unref();

function purgeStaged(makeRoom = true): void {
  const now = Date.now();
  for (const [id, s] of staged) if (now - s.created > STAGE_TTL_MS) staged.delete(id);
  // keep memory bounded: drop the oldest previews (Map keeps insertion order)
  while (makeRoom && staged.size >= MAX_STAGED) staged.delete(staged.keys().next().value as string);
}

function defaultRange(t: ExportTable): DateRange | undefined {
  const d = recordsRange(t.records);
  const r = t.declaredRange;
  if (r && d) return { from: d.from < r.from ? d.from : r.from, to: d.to > r.to ? d.to : r.to };
  return r ?? d;
}

/**
 * Degiro exports do not state their period, so coverage comes from the first/last row; a few days
 * without any movement between two imports are normal and not reported as a gap.
 */
const DEGIRO_GAP_TOLERANCE_DAYS = 10;
/** Exports that state their period (XTB, Fio and KB statements): every uncovered day is a real gap. */
function statesPeriod(kind: ExportTable['kind']): boolean {
  return kind === 'XTB' || kind === 'BANK_FIO' || kind === 'BANK_KB' || kind === 'BANK_RB_PDF';
}
function relevantGaps(kind: ExportTable['kind'], gaps: DateRange[]): DateRange[] {
  if (statesPeriod(kind)) return gaps;
  return gaps.filter((g) => daysBetween(g.from, g.to) + 1 > DEGIRO_GAP_TOLERANCE_DAYS);
}

/** Periods the export is authoritative for: its statements, or the (entered) range. */
function periodsOf(t: ExportTable, rangeOverride?: DateRange): DateRange[] | undefined {
  return rangeOverride ? [rangeOverride] : t.periods;
}

async function previewUnit(dir: string, t: ExportTable, db: CoverageDb, rangeOverride?: DateRange): Promise<{ preview: UnitPreview; stored: StoredUnit }> {
  const stored = await loadStoredUnit(dir, t);
  const hasStored = stored.records.length > 0 || stored.yearFiles.size > 0;
  const cov = effectiveCoverage(db[t.unit]?.coverage, stored.records);
  const dataRange = recordsRange(t.records);
  const range = rangeOverride ?? defaultRange(t);
  if (!range) throw new ImportError(`${t.label}: export neobsahuje žádné řádky ani období.`);
  if (!isIsoDate(range.from) || !isIsoDate(range.to) || range.from > range.to) throw new ImportError('Neplatné období exportu.');
  if (dataRange && (range.from > dataRange.from || range.to < dataRange.to)) {
    throw new ImportError(`Období exportu musí zahrnovat všechny jeho řádky (${czDate(dataRange.from)} – ${czDate(dataRange.to)}).`);
  }
  const plan = planImport(stored.records, cov, t.records, range, periodsOf(t, rangeOverride));
  const headerOk = (!stored.header || headerSignature({ header: stored.header }) === headerSignature(t)) && stored.unreadable.length === 0;
  const warnings = [...t.warnings];
  for (const u of stored.unreadable) warnings.push(`Uložený soubor ${u.path} nelze přečíst (${u.error}). Lze jen nahradit celou historii.`);
  if (stored.header && headerSignature({ header: stored.header }) !== headerSignature(t)) warnings.push('Uložená data mají jiné sloupce (např. export v jiném jazyce). Lze jen nahradit celou historii.');
  for (const g of relevantGaps(t.kind, plan.newGaps)) {
    warnings.push(
      `Mezi uloženými daty a tímto exportem chybí období ${czDate(g.from)} – ${czDate(g.to)}.` +
        (statesPeriod(t.kind) ? ' Doplňte za něj export.' : ' Pokud jste v něm neměli žádné pohyby, je vše v pořádku; jinak za něj doplňte export.'),
    );
  }
  return {
    stored,
    preview: {
      unit: t.unit,
      label: t.label,
      kind: t.kind,
      dataRange,
      declaredRange: t.declaredRange,
      range,
      rangeEditable: !statesPeriod(t.kind),
      hasStored,
      plan,
      allowedModes: headerOk ? IMPORT_MODES : ['replaceAll'],
      warnings,
    },
  };
}

async function planTables(store: string, tables: ExportTable[]): Promise<{ units: UnitPreview[]; conflict: boolean; unchanged: boolean }> {
  const db = loadCoverage(store);
  const units: UnitPreview[] = [];
  for (const t of tables) units.push((await previewUnit(store, t, db)).preview);
  return {
    units,
    conflict: units.some((u) => u.plan.conflict || u.allowedModes.length < IMPORT_MODES.length),
    unchanged: units.every((u) => u.plan.unchanged),
  };
}

async function stage(store: string, fileName: string, data: Buffer, source: StageSource): Promise<ImportPreview> {
  purgeStaged();
  const tables = await readExportTables(fileName, new Uint8Array(data));
  if (tables.length === 0) throw new ImportError(`${fileName}: export neobsahuje žádná data.`);
  if (new Set(tables.map((t) => t.unit)).size !== tables.length) throw new ImportError(`${fileName}: archiv obsahuje více výpisů stejného účtu – importujte je jednotlivě.`);
  const { units, conflict } = await planTables(store, tables);
  const id = randomUUID();
  staged.set(id, { id, created: Date.now(), store, fileName, data, hash: sha256(data), source, tables });
  return { id, fileName, units, conflict };
}

export function sanitizeFileName(name: string): string {
  return basename(name).replace(/[^\w.\- ]/g, '_') || 'export';
}

/** Preview of an export uploaded through the UI. */
export function previewUpload(store: string, fileName: string, data: Buffer): Promise<ImportPreview> {
  return locked(() => stage(store, sanitizeFileName(fileName), data, { kind: 'upload' }));
}

/** Preview of a file in the user's exports folder (must be one of its listed export files). */
export function previewInbox(store: string, inbox: string, relPath: string): Promise<ImportPreview> {
  return locked(async () => {
    const p = listExportFiles(inbox).find((f) => relExportPath(inbox, f) === relPath);
    if (!p) throw new ImportError('Soubor nebyl ve složce s exporty nalezen.', 404);
    return stage(store, basename(p), readFileSync(p), { kind: 'inbox', inbox, path: relPath });
  });
}

/** Recomputes the preview of a staged import for a period entered by the user. */
export function replanImport(id: string, range: DateRange): Promise<ImportPreview> {
  return locked(async () => {
    const s = staged.get(id);
    if (!s) throw new ImportError('Import vypršel nebo už byl dokončen. Nahrajte soubor znovu.', 404);
    if (s.tables.length !== 1) throw new ImportError('Období lze upravit jen u exportu s jedním účtem.');
    const db = loadCoverage(s.store);
    const units = [(await previewUnit(s.store, s.tables[0], db, range)).preview];
    return { id, fileName: s.fileName, units, conflict: units.some((u) => u.plan.conflict || u.allowedModes.length < IMPORT_MODES.length) };
  });
}

/** Drops a staged import. A file from the exports folder is then marked as skipped (not offered again). */
export function cancelImport(id: string): Promise<boolean> {
  return locked(async () => {
    const s = staged.get(id);
    staged.delete(id);
    if (s?.source.kind === 'inbox') {
      const m = loadManifest(s.store);
      m[s.hash] = { path: s.source.path, status: 'skipped', at: new Date().toISOString() };
      saveManifest(s.store, m);
      return true;
    }
    return false;
  });
}

// --- commit ---

export interface CommitResult {
  units: { label: string; added: number; removed: number }[];
  written: string[];
  archived: string[];
}

function archiveStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function applyTables(dir: string, tables: ExportTable[], mode: ImportMode, rangeOverride: DateRange | undefined, original: { fileName: string; data: Buffer } | null): Promise<CommitResult> {
  const db = loadCoverage(dir);
  const archiveRoot = join(dir, '_archiv', archiveStamp());
  const archiveDest = (p: string) => join(archiveRoot, relExportPath(dir, p));
  const result: CommitResult = { units: [], written: [], archived: [] };

  // 1. validate and build all new file contents before touching the stored files
  const toArchive: string[] = [];
  const toWrite: { target: string; data: string | Buffer }[] = [];
  for (const t of tables) {
    const { preview, stored } = await previewUnit(dir, t, db, rangeOverride);
    if (!preview.allowedModes.includes(mode)) throw new ImportError(`${t.label}: zvolenou možnost nelze použít – ${preview.warnings.join(' ')}`);
    const periods = periodsOf(t, rangeOverride) ?? [preview.range];
    const merged = mergeRecords(stored.records, t.records, preview.range, mode, preview.plan.storedCoverage, periods);
    const byYear = groupByYear(merged);
    const storedByYear = groupByYear(stored.records);
    const header = stored.header && mode !== 'replaceAll' ? stored.header : t.header;
    const years = new Set<number>([...stored.yearFiles.keys(), ...byYear.keys()]);
    for (const y of [...years].sort()) {
      const recs = byYear.get(y) ?? [];
      const old = stored.yearFiles.get(y);
      const target = yearFile(dir, t, y);
      let onlyAdded = false;
      if (old && old === target && mode !== 'replaceAll') {
        const d = multisetDiff(storedByYear.get(y) ?? [], recs);
        if (d.added === 0 && d.removed === 0) continue; // unchanged year file
        onlyAdded = d.removed === 0;
      }
      // bank statements arrive monthly: a year file that only gains rows is replaced in place
      // instead of filling the archive with a copy per statement (nothing stored is lost)
      if (old && !(onlyAdded && isBankKind(t.kind))) toArchive.push(old);
      if (recs.length) toWrite.push({ target, data: t.kind === 'XTB' ? await writeXtbCashBook(header, recs) : writeCsv(header, recs) });
    }
    if (isBankKind(t.kind) && t.balances?.length) {
      // balances stated in bank statements are facts for their day: union with the stored ones
      const target = join(unitRoot(dir, t), BANK_BALANCES_FILE);
      const old = existsSync(target) ? readStoredBalances(target) : null;
      // same rules as the rows: replaceAll = only the export, keepExisting = stored ones win,
      // merge = inside the export's periods (incl. the opening balance the day before) the export wins
      const stored = old?.points ?? [];
      const inPeriods = (date: string) => periods.some((r) => date >= addDays(r.from, -1) && date <= r.to);
      const merged =
        mode === 'replaceAll'
          ? mergeBalances([], t.balances)
          : mode === 'keepExisting'
            ? mergeBalances(t.balances, stored)
            : mergeBalances(
                stored.filter((p) => !inPeriods(p.date)),
                t.balances,
              );
      const data = writeBalancesCsv({ bank: KIND_BANK[t.kind], number: String((t.header[0] as unknown[])[3] ?? t.account ?? ''), currency: t.currency ?? 'CZK' }, merged);
      if (!old || old.text !== data) {
        const keepsAll = !!old && old.points.every((p) => merged.some((q) => q.date === p.date && q.balance === p.balance));
        if (existsSync(target) && !keepsAll) toArchive.push(target);
        toWrite.push({ target, data });
      }
    }
    if (t.statements?.length && isBankKind(t.kind)) {
      // statement summaries: a statement of the same period and number is replaced, the rest stays
      // (replaceAll keeps only the imported statements)
      const target = join(unitRoot(dir, t), BANK_STATEMENTS_FILE);
      let oldText: string | null = null;
      let old: StatementSummary[] = [];
      try {
        if (existsSync(target)) {
          oldText = readFileSync(target, 'utf-8');
          old = readStatementsCsv(oldText).statements;
        }
      } catch {
        /* unreadable: rewritten from the import */
      }
      const incomingKeys = new Set(t.statements.map(statementKey));
      const kept = mode === 'replaceAll' ? [] : mode === 'keepExisting' ? old : old.filter((s) => !incomingKeys.has(statementKey(s)) && !periods.some((r) => s.from >= r.from && s.to <= r.to));
      const keptKeys = new Set(kept.map(statementKey));
      const mergedStatements = [...kept, ...t.statements.filter((s) => !keptKeys.has(statementKey(s)))];
      const data = writeStatementsCsv({ bank: KIND_BANK[t.kind], number: String((t.header[0] as unknown[])[3] ?? t.account ?? ''), currency: t.currency ?? 'CZK' }, mergedStatements);
      if (oldText !== data) {
        if (oldText !== null && old.some((s) => !mergedStatements.some((m) => statementKey(m) === statementKey(s)))) toArchive.push(target);
        toWrite.push({ target, data });
      }
    }
    for (const a of t.attachments ?? []) {
      // copies of the source PDFs; a different file under the same name (a corrected statement)
      // replaces the old copy, which goes to the archive
      const target = join(unitRoot(dir, t), ...a.path.split('/'));
      if (!isInside(target, unitRoot(dir, t))) continue;
      if (existsSync(target)) {
        if (sha256(readFileSync(target)) === sha256(a.data)) continue;
        toArchive.push(target);
      }
      toWrite.push({ target, data: Buffer.from(a.data) });
    }
    const entry: CoverageEntry = { coverage: nextCoverage(preview.plan.storedCoverage, preview.range, mode, periods), openPositionsAsOf: db[t.unit]?.openPositionsAsOf };
    if (t.kind === 'XTB' && t.openPositions && (!entry.openPositionsAsOf || mode === 'replaceAll' || t.openPositions.asOf >= entry.openPositionsAsOf)) {
      const root = unitRoot(dir, t);
      if (isDir(root)) for (const n of readdirSync(root)) if (/_open-positions\.xlsx$/.test(n)) toArchive.push(join(root, n));
      toWrite.push({ target: join(root, xtbOpenPositionsFileName(t.currency ?? 'CZK', t.account ?? 'ucet')), data: await writeXtbOpenPositionsBook(t.openPositions.rows) });
      entry.openPositionsAsOf = t.openPositions.asOf;
    }
    db[t.unit] = entry;
    const d = multisetDiff(stored.records, merged); // what the chosen mode actually changes
    result.units.push({ label: t.label, added: d.added, removed: d.removed });
  }
  const coverageTarget = join(dir, COVERAGE_FILE);
  toWrite.push({ target: coverageTarget, data: JSON.stringify({ version: 1, units: db }, null, 2) });

  // 2. write everything to temporary files – a failure here leaves the stored data untouched
  const tmpOf = (target: string) => `${target}.${process.pid}.tmp`;
  try {
    for (const w of toWrite) {
      mkdirSync(dirname(w.target), { recursive: true });
      writeFileSync(tmpOf(w.target), w.data);
    }
  } catch (e) {
    for (const w of toWrite) rmSync(tmpOf(w.target), { force: true });
    throw e;
  }

  // 3. swap: archive the replaced files and move the new ones in; undo everything on failure
  const undo: (() => void)[] = [];
  const backups: string[] = [];
  try {
    for (const old of toArchive) {
      const dest = archiveDest(old);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(old, dest);
      undo.push(() => renameSync(dest, old));
    }
    for (const w of toWrite) {
      if (existsSync(w.target)) {
        // replaced in place (the coverage file): keep a backup until the whole swap succeeded
        const backup = `${w.target}.${process.pid}.bak`;
        renameSync(w.target, backup);
        backups.push(backup);
        undo.push(() => renameSync(backup, w.target));
      }
      renameSync(tmpOf(w.target), w.target);
      undo.push(() => rmSync(w.target, { force: true }));
    }
  } catch (e) {
    for (const u of undo.reverse()) {
      try {
        u();
      } catch {
        /* best effort – archived copies stay in _archiv */
      }
    }
    for (const w of toWrite) rmSync(tmpOf(w.target), { force: true });
    throw new ImportError(`Import se nepodařilo dokončit, uložená data zůstala beze změny: ${(e as Error).message}`, 500);
  }
  for (const b of backups) rmSync(b, { force: true });
  result.archived.push(...toArchive.map((p) => relExportPath(dir, p)));
  result.written.push(...toWrite.filter((w) => w.target !== coverageTarget).map((w) => relExportPath(dir, w.target)));

  // 4. keep a copy of an uploaded export (files from the exports folder stay where they are)
  if (original) {
    try {
      writeAtomic(join(archiveRoot, 'import', original.fileName), original.data);
    } catch {
      /* the import itself succeeded */
    }
  }
  return result;
}

export function commitImport(id: string, mode: ImportMode, range: DateRange | undefined, store: string): Promise<CommitResult> {
  return locked(async () => {
    const s = staged.get(id);
    if (!s) throw new ImportError('Import vypršel nebo už byl dokončen. Nahrajte soubor znovu.', 404);
    if (s.store !== store) throw new ImportError('Úložiště dat se mezitím změnilo. Nahrajte soubor znovu.', 409);
    if (!IMPORT_MODES.includes(mode)) throw new ImportError('Neznámý způsob importu.');
    if (range && s.tables.length !== 1) throw new ImportError('Období lze upravit jen u exportu s jedním účtem.');
    const r = await applyTables(s.store, s.tables, mode, range, s.source.kind === 'upload' ? { fileName: s.fileName, data: s.data } : null);
    staged.delete(id);
    // remember the content, so the same export in the exports folder is not imported again
    try {
      const m = loadManifest(s.store);
      m[s.hash] = { path: s.source.kind === 'inbox' ? s.source.path : `(nahráno) ${s.fileName}`, status: 'imported', at: new Date().toISOString() };
      saveManifest(s.store, m);
    } catch {
      /* the data are stored; at worst the file is planned again (as unchanged) on the next scan */
    }
    return r;
  });
}

// --- the user's exports folder (read only) ---

export type InboxStatus = 'imported' | 'unchanged' | 'pending' | 'skipped' | 'busy' | 'unsupported' | 'error';

interface ManifestEntry {
  /** path in the exports folder (or the uploaded file name) when last seen */
  path: string;
  status: InboxStatus;
  at: string;
  message?: string;
}
/** keyed by the SHA-256 of the file content */
type Manifest = Record<string, ManifestEntry>;

export const MANIFEST_FILE = 'imports.json';

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function loadManifest(store: string): Manifest {
  const p = join(store, MANIFEST_FILE);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { files?: Manifest };
    const out: Manifest = {};
    for (const [h, e] of Object.entries(raw.files ?? {})) {
      if (/^[0-9a-f]{64}$/.test(h) && e && typeof e.path === 'string' && typeof e.status === 'string') out[h] = e;
    }
    return out;
  } catch {
    return {};
  }
}

function saveManifest(store: string, m: Manifest): void {
  writeAtomic(join(store, MANIFEST_FILE), JSON.stringify({ version: 1, files: m }, null, 2));
}

export interface InboxFile {
  path: string;
  kind: string;
  status: InboxStatus;
  message?: string;
}

/**
 * Imports new or changed export files from the user's exports folder into the store. The folder is
 * never written to. A file that only adds rows is merged right away; a file that would remove or
 * change stored rows waits for the user's decision in Settings. Content already seen is skipped.
 */
/** Larger files are not exports (uploads have the same limit). */
const MAX_INBOX_FILE_BYTES = 100 * 1024 * 1024;
/** A file changed this recently may still be being copied into the folder. */
const SETTLE_MS = 5000;

export function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

async function scanInbox(store: string, inbox: string, settleMs: number): Promise<{ files: InboxFile[]; messages: string[] }> {
  const messages: string[] = [];
  const manifest = loadManifest(store);
  const manifestBefore = JSON.stringify(manifest);
  const seen: { path: string; rel: string; hash: string; kind: string; data?: Buffer; note?: string }[] = [];
  for (const p of listExportFiles(inbox)) {
    if (isInside(p, store)) continue; // never treat the app's own files as exports
    const rel = relExportPath(inbox, p);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.size > MAX_INBOX_FILE_BYTES) {
      seen.push({ path: p, rel, hash: '', kind: 'TOO_BIG', note: 'soubor je větší než 100 MB, nejde o export' });
      continue;
    }
    if (settleMs > 0 && Date.now() - st.mtimeMs < settleMs) {
      seen.push({ path: p, rel, hash: '', kind: 'BUSY', note: 'soubor se právě mění – načte se při příštím přepočtu' });
      continue;
    }
    let data: Buffer;
    try {
      data = readFileSync(p);
    } catch {
      continue;
    }
    seen.push({ path: p, rel, hash: sha256(data), kind: detectFileKind(p, new Uint8Array(data.subarray(0, 4000))), data });
  }

  // new files, files waiting for a decision and failed ones (the stored data may have changed meanwhile)
  const todo: { rel: string; hash: string; tables: ExportTable[]; end: string }[] = [];
  const queued = new Set<string>();
  for (const f of seen) {
    if (!f.data || f.kind === 'UNKNOWN') continue; // other banks' statements etc. are never recorded
    const known = manifest[f.hash];
    if (known && known.status !== 'pending' && known.status !== 'error') {
      known.path = f.rel;
      continue;
    }
    if (queued.has(f.hash)) continue; // the same content twice in the folder
    queued.add(f.hash);
    try {
      const tables = await readExportTables(basename(f.path), new Uint8Array(f.data));
      if (tables.length === 0) throw new ImportError('export neobsahuje žádná data');
      todo.push({ rel: f.rel, hash: f.hash, tables, end: tables.map((t) => defaultRange(t)?.to ?? '').sort().pop() ?? '' });
    } catch (e) {
      // a file that is not an export (another PDF) is remembered and not read again on every scan
      manifest[f.hash] = { path: f.rel, status: e instanceof UnsupportedFileError ? 'unsupported' : 'error', at: new Date().toISOString(), message: (e as Error).message };
    }
  }
  // newest export first: a corrected newer export becomes effective, an older one that differs
  // from it waits for a decision (auto-import never removes stored rows)
  todo.sort((a, b) => (a.end > b.end ? -1 : a.end < b.end ? 1 : a.rel < b.rel ? -1 : 1));
  for (const f of todo) {
    const at = new Date().toISOString();
    try {
      const plan = await planTables(store, f.tables);
      if (plan.unchanged) manifest[f.hash] = { path: f.rel, status: 'unchanged', at };
      else if (plan.conflict) manifest[f.hash] = { path: f.rel, status: 'pending', at, message: 'Export se liší od uložených dat – rozhodněte, co s rozdíly.' };
      else {
        const r = await applyTables(store, f.tables, 'merge', undefined, null);
        const added = r.units.reduce((s, u) => s + u.added, 0);
        // notes such as skipped PDFs stay visible with the file after a restart
        const notes = [...new Set(plan.units.flatMap((u) => u.warnings))];
        manifest[f.hash] = { path: f.rel, status: 'imported', at, message: [`nových řádků: ${added}`, ...notes].join(' · ').slice(0, 1000) };
        messages.push(`Importován soubor ${f.rel} (nových řádků: ${added}).`);
        for (const w of plan.units.flatMap((u) => u.warnings)) messages.push(`${f.rel}: ${w}`);
      }
    } catch (e) {
      manifest[f.hash] = { path: f.rel, status: 'error', at, message: (e as Error).message };
    }
  }
  if (JSON.stringify(manifest) !== manifestBefore) saveManifest(store, manifest);

  const files: InboxFile[] = seen.map((f) => {
    if (f.note) return { path: f.rel, kind: KIND_LABEL.UNKNOWN, status: f.kind === 'BUSY' ? 'busy' : 'unsupported', message: f.note };
    if (f.kind === 'UNKNOWN') return { path: f.rel, kind: KIND_LABEL.UNKNOWN, status: 'unsupported' };
    const e = manifest[f.hash];
    return { path: f.rel, kind: KIND_LABEL[f.kind] ?? f.kind, status: e?.status ?? 'error', message: e?.message };
  });
  for (const f of files) if (f.status === 'error') messages.push(`${f.path}: import se nezdařil – ${f.message ?? 'neznámá chyba'}`);
  return { files, messages };
}

// --- description for the UI ---

export interface StorageUnitInfo {
  unit: string;
  label: string;
  coverage: DateRange[];
  gaps: DateRange[];
  years: { year: number; rows: number }[];
  openPositionsAsOf?: string;
  unreadable: string[];
}

export interface StorageInfo {
  /** where the imported data are kept (inside the app's data dir) */
  storeDir: string;
  units: StorageUnitInfo[];
  /** export files found in the user's exports folder and their import status */
  inbox: InboxFile[];
}

function readStoredBalances(path: string): { text: string; points: BalancePoint[] } | null {
  try {
    const text = readFileSync(path, 'utf-8');
    return { text, points: readBalancesCsv(text).points };
  } catch {
    return null;
  }
}

/** Marker row of a stored bank file: account number and currency */
function bankMarker(path: string): { number: string; currency: string } | null {
  try {
    const first = readFileSync(path, 'utf-8').replace(/^﻿/, '').split(/\r?\n/)[0].split(',');
    if (first[0] !== BANK_MARKER) return null;
    return { number: first[3] ?? '', currency: first[4] || 'CZK' };
  } catch {
    return null;
  }
}

const BANK_UNIT_LABEL = { FIO: 'Fio', KB: 'KB', RB: 'Raiffeisenbank' } as const;

function storedUnits(dir: string): UnitRef[] {
  const out: UnitRef[] = [];
  for (const kind of ['DEGIRO_TX', 'DEGIRO_ACCOUNT'] as const) {
    const u: UnitRef = { ...degiroUnit(kind), kind };
    if (unitYearFiles(dir, u).size) out.push(u);
  }
  const xtbRoot = join(dir, 'xtb');
  if (isDir(xtbRoot)) {
    for (const account of readdirSync(xtbRoot)) {
      if (account.startsWith('_') || !/^[\w-]+$/.test(account) || !isDir(join(xtbRoot, account))) continue;
      const probe: UnitRef = { unit: `xtb/${account}`, kind: 'XTB', label: '', account };
      const files = unitYearFiles(dir, probe);
      const first = [...files.values()][0];
      if (!first) continue;
      const currency = /^([A-Z]{3})_/.exec(basename(first))?.[1] ?? 'CZK';
      out.push({ ...probe, currency, label: `XTB – účet ${account} (${currency})` });
    }
  }
  for (const kind of ['BANK_FIO', 'BANK_KB', 'BANK_RB'] as const) {
    const bank = KIND_BANK[kind];
    const root = join(dir, 'banks', bank.toLowerCase());
    if (!isDir(root)) continue;
    for (const account of readdirSync(root)) {
      if (account.startsWith('_') || !/^[\w-]+$/.test(account) || !isDir(join(root, account))) continue;
      const probe: UnitRef = { unit: `banks/${bank.toLowerCase()}/${account}`, kind, label: '', account };
      const first = [...unitYearFiles(dir, probe).values()][0];
      const balances = join(root, account, BANK_BALANCES_FILE);
      // an account without any movement (e.g. a foreign currency account) has only stated balances;
      // RB CSV exports carry no balances, so there the balances come from PDF statements
      const meta = (first && bankMarker(first)) ?? (kind !== 'BANK_RB' && existsSync(balances) ? bankMarker(balances) : null);
      if (meta) out.push({ ...probe, currency: meta.currency, label: `${BANK_UNIT_LABEL[bank]} – účet ${meta.number || account} (${meta.currency})` });
      if (kind === 'BANK_RB') {
        const pdf: UnitRef = { unit: `${probe.unit}/pdf`, kind: 'BANK_RB_PDF', label: '', account };
        const pdfFirst = [...unitYearFiles(dir, pdf).values()][0];
        const statements = join(root, account, BANK_STATEMENTS_FILE);
        const pdfMeta = (pdfFirst && bankMarker(pdfFirst)) ?? (existsSync(statements) ? bankMarker(statements) : null);
        if (pdfMeta) out.push({ ...pdf, currency: pdfMeta.currency, label: `${BANK_UNIT_LABEL[bank]} – účet ${pdfMeta.number || account} (${pdfMeta.currency}) – PDF výpisy` });
      }
    }
  }
  return out;
}

const KIND_LABEL: Record<string, string> = {
  DEGIRO_TX: 'Degiro – transakce',
  DEGIRO_ACCOUNT: 'Degiro – výpis z účtu',
  XTB: 'XTB',
  BANK_FIO: 'Fio banka – výpis',
  BANK_KB: 'Komerční banka – výpis',
  BANK_RB: 'Raiffeisenbank – pohyby',
  BANK_RB_PDF: 'Raiffeisenbank – PDF výpis',
  UNKNOWN: 'neznámý formát',
};

/**
 * Everything the snapshot needs, under the import lock so that a running import never leaves the
 * computation with a mix of old and new year files: new exports from the exports folder are imported
 * first, then the store's year files are read.
 */
export function loadExportsForSnapshot(store: string, inbox: string, opts: { settleMs?: number } = {}): Promise<{ files: { name: string; data: Uint8Array }[]; storage: StorageInfo; messages: string[] }> {
  return locked(async () => {
    let inboxFiles: InboxFile[] = [];
    let messages: string[] = [];
    try {
      ({ files: inboxFiles, messages } = await scanInbox(store, inbox, opts.settleMs ?? SETTLE_MS));
    } catch (e) {
      messages = [`Import exportů selhal: ${(e as Error).message}`];
    }
    const files = classifyExportFiles(store).files.map((p) => ({ name: p, data: new Uint8Array(readFileSync(p)) }));
    const units = await describeUnits(store);
    for (const u of units) for (const f of u.unreadable) messages.push(`Uložený soubor ${f} nelze přečíst – importujte celou historii znovu.`);
    for (const f of inboxFiles) if (f.status === 'pending') messages.push(`${f.path}: export se liší od uložených dat a čeká na rozhodnutí v Nastavení.`);
    return { files, storage: { storeDir: store, units, inbox: inboxFiles }, messages };
  });
}

async function describeUnits(dir: string): Promise<StorageUnitInfo[]> {
  const db = loadCoverage(dir);
  const units: StorageUnitInfo[] = [];
  for (const u of storedUnits(dir)) {
    const stored = await loadStoredUnit(dir, u);
    const coverage = effectiveCoverage(db[u.unit]?.coverage, stored.records);
    units.push({
      unit: u.unit,
      label: u.label,
      coverage,
      gaps: relevantGaps(u.kind, rangeGaps(coverage)),
      years: [...groupByYear(stored.records)].sort((a, b) => a[0] - b[0]).map(([year, recs]) => ({ year, rows: recs.length })),
      openPositionsAsOf: db[u.unit]?.openPositionsAsOf,
      unreadable: stored.unreadable.map((x) => x.path),
    });
  }
  return units;
}
