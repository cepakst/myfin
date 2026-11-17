import type { InputFile } from '../parsers/index.js';
import {
  bankAccountId,
  bankTxsFromTable,
  decodeBankText,
  detectBankKind,
  isBalancesFile,
  isStatementsFile,
  mergeBalances,
  readBalancesCsv,
  readBankTables,
  readStatementsCsv,
  statementKey,
} from './bankTables.js';
import { emptyBankLedger, type BankAccountData, type BankLedger, type BankTx, type StatementSummary } from './types.js';

/** fields a PDF statement can add to a movement from the CSV export (and the other way round) */
const FILL: (keyof BankTx)[] = ['valueDate', 'origAmount', 'origCurrency', 'cpAccount', 'cpName', 'merchant', 'city', 'vs', 'ks', 'ss', 'message', 'note', 'bankCategory'];

/**
 * Combines the same movement read from the CSV export and from a PDF statement: the CSV values win
 * (machine-readable, no wrapped text), the statement fills what the CSV lacks.
 */
function combine(csv: BankTx, pdf: BankTx): BankTx {
  const out: BankTx = { ...csv, source: 'both' };
  for (const k of FILL) if (out[k] === undefined && pdf[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = pdf[k];
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Movements read from a PDF statement without a transaction id cannot be paired by key: pair them
 * with a CSV movement of the same account, day and amount that has no statement counterpart yet.
 */
function pairWithoutId(ledger: BankLedger): void {
  const pdfOnly = ledger.txs.filter((t) => t.source === 'pdf' && !t.bankTxId && !t.key.endsWith('#fee'));
  if (!pdfOnly.length) return;
  const csvFree = new Map<string, number[]>();
  ledger.txs.forEach((t, i) => {
    if (t.source !== 'csv' || t.key.endsWith('#fee')) return;
    const k = `${t.accountId}|${t.date}|${t.amount.toFixed(2)}`;
    const list = csvFree.get(k);
    if (list) list.push(i);
    else csvFree.set(k, [i]);
  });
  const drop = new Set<BankTx>();
  for (const p of pdfOnly) {
    const i = csvFree.get(`${p.accountId}|${p.date}|${p.amount.toFixed(2)}`)?.shift();
    if (i === undefined) continue;
    ledger.txs[i] = combine(ledger.txs[i], p);
    drop.add(p);
  }
  if (drop.size) ledger.txs = ledger.txs.filter((t) => !drop.has(t));
}

/**
 * Bank ledger from stored bank year files and balance files (or raw bank exports in demo mode).
 * Files that are not bank statements are ignored. The same transaction found in two files
 * (overlapping raw exports, or the CSV export and a PDF statement) is counted once.
 */
export function buildBankLedger(files: readonly InputFile[]): BankLedger {
  const ledger = emptyBankLedger();
  const byKey = new Map<string, number>();
  const statements = new Map<string, StatementSummary[]>();
  const differing = new Map<string, number>();
  const upsert = (a: BankAccountData) => {
    const cur = ledger.accounts.get(a.id);
    if (!cur) ledger.accounts.set(a.id, { ...a, balancePoints: [...a.balancePoints] });
    else {
      cur.name ??= a.name;
      cur.balancePoints = mergeBalances(cur.balancePoints, a.balancePoints);
    }
  };
  for (const f of files) {
    try {
      if (isStatementsFile(f.name)) {
        const { meta, statements: list } = readStatementsCsv(decodeBankText(f.data));
        if (meta) {
          const id = bankAccountId(meta.bank, meta.number, meta.currency);
          upsert({ id, bank: meta.bank, number: meta.number, currency: meta.currency, balancePoints: [] });
          statements.set(id, [...(statements.get(id) ?? []), ...list]);
        }
        continue;
      }
      const kind = detectBankKind(f.name, f.data);
      if (!kind) continue;
      if (isBalancesFile(f.name)) {
        const { meta, points } = readBalancesCsv(decodeBankText(f.data));
        if (meta) upsert({ id: bankAccountId(meta.bank, meta.number, meta.currency), bank: meta.bank, number: meta.number, currency: meta.currency, balancePoints: points });
        continue;
      }
      for (const t of readBankTables(f.name, f.data, kind)) {
        for (const w of t.warnings) ledger.warnings.push({ source: f.name, message: w });
        const { account, txs } = bankTxsFromTable(t);
        upsert(account);
        for (const tx of txs) {
          const i = byKey.get(tx.key);
          if (i === undefined) {
            byKey.set(tx.key, ledger.txs.length);
            ledger.txs.push(tx);
            continue;
          }
          const prev = ledger.txs[i];
          const pair = prev.source === 'pdf' && tx.source === 'csv' ? [tx, prev] : prev.source === 'csv' && tx.source === 'pdf' ? [prev, tx] : null;
          if (!pair) continue; // the same source twice (overlapping exports): the first one stays
          const [csv, pdf] = pair;
          if (Math.abs(csv.amount - pdf.amount) >= 0.005 || csv.date !== pdf.date) differing.set(csv.accountId, (differing.get(csv.accountId) ?? 0) + 1);
          ledger.txs[i] = combine(csv, pdf);
        }
      }
    } catch (e) {
      ledger.warnings.push({ source: f.name, message: `Chyba při načítání: ${(e as Error).message}` });
    }
  }
  pairWithoutId(ledger);
  ledger.txs.sort((a, b) => (a.date === b.date ? (a.key < b.key ? -1 : 1) : a.date < b.date ? -1 : 1));

  for (const [id, n] of differing) {
    ledger.warnings.push({ source: id, message: `${n} pohybů se v CSV exportu a v PDF výpisu liší částkou nebo datem – použity hodnoty z CSV.` });
  }
  // every statement's movements must add up to its totals (a missing or doubled movement shows here
  // even when the balances happen to match)
  for (const [id, list] of statements) {
    const txs = ledger.txs.filter((t) => t.accountId === id);
    const seen = new Set<string>();
    for (const s of list) {
      if (seen.has(statementKey(s))) continue;
      seen.add(statementKey(s));
      const inPeriod = txs.filter((t) => t.date >= s.from && t.date <= s.to);
      const income = round2(inPeriod.filter((t) => t.amount > 0).reduce((x, t) => x + t.amount, 0));
      const expense = round2(-inPeriod.filter((t) => t.amount < 0).reduce((x, t) => x + t.amount, 0));
      if (Math.abs(income - s.income) >= 0.01 || Math.abs(expense - s.expense) >= 0.01) {
        ledger.warnings.push({
          source: id,
          message: `Pohyby v období výpisu č. ${s.seq} (${s.from} – ${s.to}) nesedí na jeho součty (příjmy ${income.toFixed(2)} místo ${s.income.toFixed(2)}, výdaje ${expense.toFixed(2)} místo ${s.expense.toFixed(2)}). Některý pohyb chybí nebo je navíc.`,
        });
      }
    }
  }
  return ledger;
}
