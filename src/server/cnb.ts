import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCnbYear, type CnbFixing } from '../core/fx.js';
import { CACHE_DIR, ensureDir } from './paths.js';

const CNB_URL = 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok=';
const CURRENT_YEAR_TTL_MS = 6 * 3600 * 1000;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'myfin/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

/** Loads CNB daily fixings for the given years (cached in data/cache/cnb). */
export async function loadCnbFixings(fromYear: number, toYear: number, log: (m: string) => void = () => {}): Promise<{ fixings: CnbFixing[]; errors: string[] }> {
  const dir = ensureDir(join(CACHE_DIR, 'cnb'));
  const fixings: CnbFixing[] = [];
  const errors: string[] = [];
  const nowYear = new Date().getFullYear();
  // include the previous year so early-January dates have a preceding fixing
  for (let y = fromYear - 1; y <= toYear; y++) {
    const file = join(dir, `${y}.txt`);
    let text: string | null = null;
    const fresh = existsSync(file) && (y < nowYear ? true : Date.now() - statSync(file).mtimeMs < CURRENT_YEAR_TTL_MS);
    if (fresh) text = readFileSync(file, 'utf-8');
    else {
      try {
        log(`Stahuji kurzy ČNB ${y}`);
        text = await fetchText(CNB_URL + y);
        if (y < nowYear && !/^31\.12\.|^30\.12\.|^29\.12\.|^28\.12\./m.test(text)) {
          // incomplete past year (should not happen) – do not cache permanently
          writeFileSync(file + '.partial', text);
        } else writeFileSync(file, text);
      } catch (e) {
        if (existsSync(file)) text = readFileSync(file, 'utf-8');
        errors.push(`Kurzy ČNB ${y}: ${(e as Error).message}`);
      }
    }
    if (text) fixings.push(...parseCnbYear(text));
  }
  return { fixings, errors };
}
