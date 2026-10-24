import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
      } else if (EXPORT_EXT.test(n)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
