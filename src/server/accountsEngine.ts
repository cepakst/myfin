/**
 * Accounts module snapshot. The bank ledger is read together with the investment exports (one
 * import scan, see engine.ts); the snapshot itself is cheap and is recomputed on its own when the
 * accounts configuration changes. No network access.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { sanitizeAccountsConfig, summarizeAccounts, type AccountsConfig, type AccountsSummary, type CzkConverter } from '../core/accounts/analytics.js';
import type { BankLedger } from '../core/accounts/types.js';
import { todayIso } from '../core/util.js';
import { ACCOUNTS_FILE, DATA_DIR, DEMO_ACCOUNTS_FILE, ensureDir } from './paths.js';

export interface AccountsSnapshot extends AccountsSummary {
  generatedAt: string;
  today: string;
  demo: boolean;
  config: AccountsConfig;
}

interface AccountsState {
  ledger?: BankLedger;
  toCzk?: CzkConverter;
  demo: boolean;
  snapshot?: AccountsSnapshot;
}

export const accountsState: AccountsState = { demo: false };

export function accountsConfigFile(demo: boolean): string {
  return demo ? DEMO_ACCOUNTS_FILE : ACCOUNTS_FILE;
}

/**
 * Reads the config. An unreadable file yields the defaults, unless `strict` is set: then it throws,
 * so that a partial update (categorize) never saves the defaults over the user's damaged file.
 */
export function loadAccountsConfig(demo: boolean, strict = false): AccountsConfig {
  const file = accountsConfigFile(demo);
  try {
    if (existsSync(file)) return sanitizeAccountsConfig(JSON.parse(readFileSync(file, 'utf-8')));
  } catch (e) {
    if (strict) throw new Error(`Soubor s nastavením účtů nelze přečíst (${file}): ${(e as Error).message}`);
  }
  return sanitizeAccountsConfig(undefined);
}

/** Writes through a temporary file and a rename, so an interrupted write never truncates the config. */
export function saveAccountsConfig(demo: boolean, config: AccountsConfig): void {
  ensureDir(DATA_DIR);
  const file = accountsConfigFile(demo);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, file);
}

/** Computes the accounts snapshot from the bank ledger read by the last engine run. */
export function computeAccounts(ledger: BankLedger, opts: { demo: boolean; toCzk: CzkConverter }): AccountsSnapshot {
  accountsState.ledger = ledger;
  accountsState.toCzk = opts.toCzk;
  accountsState.demo = opts.demo;
  return refreshAccounts();
}

/** Recomputes the snapshot with the current configuration (e.g. after the user renamed an account). */
export function refreshAccounts(): AccountsSnapshot {
  const ledger = accountsState.ledger ?? { accounts: new Map(), txs: [], warnings: [] };
  const config = loadAccountsConfig(accountsState.demo);
  const today = todayIso();
  const summary = summarizeAccounts(ledger, config, today, accountsState.toCzk ?? (() => null));
  accountsState.snapshot = { ...summary, generatedAt: new Date().toISOString(), today, demo: accountsState.demo, config };
  return accountsState.snapshot;
}
