/**
 * Accounts module snapshot. The bank ledger is read together with the investment exports (one
 * import scan, see engine.ts); the snapshot itself is cheap and is recomputed on its own when the
 * accounts configuration changes. No network access.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

export function loadAccountsConfig(demo: boolean): AccountsConfig {
  const file = accountsConfigFile(demo);
  try {
    if (existsSync(file)) return sanitizeAccountsConfig(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    /* fall through to defaults */
  }
  return sanitizeAccountsConfig(undefined);
}

export function saveAccountsConfig(demo: boolean, config: AccountsConfig): void {
  ensureDir(DATA_DIR);
  writeFileSync(accountsConfigFile(demo), JSON.stringify(config, null, 2));
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
