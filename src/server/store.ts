import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { mergeSettings, type Settings } from '../core/settings.js';
import { DATA_DIR, ensureDir, SETTINGS_FILE } from './paths.js';

export function loadSettings(file = SETTINGS_FILE): Settings {
  try {
    if (existsSync(file)) return mergeSettings(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    /* fall through to defaults */
  }
  return mergeSettings(undefined);
}

export function saveSettings(s: Settings, file = SETTINGS_FILE): void {
  ensureDir(DATA_DIR);
  writeFileSync(file, JSON.stringify(s, null, 2));
}

const EXPORT_EXT = /\.(csv|xlsx|zip)$/i;

export function listExportFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!n.startsWith('_')) walk(p);
      } else if (EXPORT_EXT.test(n) && !n.startsWith('~$')) out.push(p); // ~$ = Excel lock file
    }
  };
  walk(dir);
  return out.sort();
}

/** Files in the layout written by the import (paths relative to the exports dir, '/' separated). */
const CANONICAL = [/^degiro\/\d{4}\/(Transactions|Account)\.csv$/, /^xtb\/[\w-]+\/\d{4}\/[A-Z]{3}_[\w-]+_\d{4}\.xlsx$/, /^xtb\/[\w-]+\/[A-Z]{3}_[\w-]+_open-positions\.xlsx$/];

export function relExportPath(dir: string, file: string): string {
  return relative(dir, file).split(sep).join('/');
}

export function isCanonicalExport(relPath: string): boolean {
  return CANONICAL.some((re) => re.test(relPath));
}

/**
 * Splits the exports dir into the stored year files (loaded) and loose files the user copied there
 * (not loaded until imported, otherwise overlapping periods would be counted twice).
 */
export function classifyExportFiles(dir: string): { files: string[]; loose: string[] } {
  const files: string[] = [];
  const loose: string[] = [];
  for (const p of listExportFiles(dir)) (isCanonicalExport(relExportPath(dir, p)) ? files : loose).push(p);
  return { files, loose };
}
