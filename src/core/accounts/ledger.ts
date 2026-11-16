import type { InputFile } from '../parsers/index.js';
import { bankTxsFromTable, decodeBankText, detectBankKind, isBalancesFile, mergeBalances, readBalancesCsv, readBankTables } from './bankTables.js';
import { BANK_CODE, emptyBankLedger, type BankAccountData, type BankLedger } from './types.js';

/**
 * Bank ledger from stored bank year files and balance files (or raw bank exports in demo mode).
 * Files that are not bank statements are ignored. The same transaction found in two files
 * (overlapping raw exports) is counted once.
 */
export function buildBankLedger(files: readonly InputFile[]): BankLedger {
  const ledger = emptyBankLedger();
  const seen = new Set<string>();
  const upsert = (a: BankAccountData) => {
    const cur = ledger.accounts.get(a.id);
    if (!cur) ledger.accounts.set(a.id, { ...a, balancePoints: [...a.balancePoints] });
    else {
      cur.name ??= a.name;
      cur.balancePoints = mergeBalances(cur.balancePoints, a.balancePoints);
    }
  };
  for (const f of files) {
    const kind = detectBankKind(f.name, f.data);
    if (!kind) continue;
    try {
      if (isBalancesFile(f.name)) {
        const { meta, points } = readBalancesCsv(decodeBankText(f.data));
        if (meta) upsert({ id: `${meta.number}/${BANK_CODE[meta.bank]}`, bank: meta.bank, number: meta.number, currency: meta.currency, balancePoints: points });
        continue;
      }
      for (const t of readBankTables(f.name, f.data, kind)) {
        for (const w of t.warnings) ledger.warnings.push({ source: f.name, message: w });
        const { account, txs } = bankTxsFromTable(t);
        upsert(account);
        for (const tx of txs) {
          if (seen.has(tx.key)) continue;
          seen.add(tx.key);
          ledger.txs.push(tx);
        }
      }
    } catch (e) {
      ledger.warnings.push({ source: f.name, message: `Chyba při načítání: ${(e as Error).message}` });
    }
  }
  ledger.txs.sort((a, b) => (a.date === b.date ? (a.key < b.key ? -1 : 1) : a.date < b.date ? -1 : 1));
  return ledger;
}
