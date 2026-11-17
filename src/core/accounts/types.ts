/** Bank accounts module: normalised bank transactions and accounts (pure data, no I/O). */

export type Bank = 'FIO' | 'KB' | 'RB';

export const BANKS: Bank[] = ['FIO', 'KB', 'RB'];

export const BANK_NAME: Record<Bank, string> = { FIO: 'Fio banka', KB: 'Komerční banka', RB: 'Raiffeisenbank' };

/** Czech bank codes of the supported banks */
export const BANK_CODE: Record<Bank, string> = { FIO: '2010', KB: '0100', RB: '5500' };

export type ProductType = 'current' | 'savings' | 'term' | 'credit' | 'other';

export const PRODUCT_LABEL: Record<ProductType, string> = {
  current: 'Běžný účet',
  savings: 'Spořicí účet',
  term: 'Termínovaný vklad',
  credit: 'Kreditní karta / úvěr',
  other: 'Jiný produkt',
};

export interface BankTx {
  /** stable id across re-imports: `<bank>:<account>:<bank transaction id>` (or a content hash) */
  key: string;
  bank: Bank;
  /** `<number>/<bank code>` of the user's account */
  accountId: string;
  /** booking date (ISO) */
  date: string;
  /** execution / value date when the bank states it and it differs */
  valueDate?: string;
  /** in account currency; negative = outgoing */
  amount: number;
  currency: string;
  origAmount?: number;
  origCurrency?: string;
  /** counterparty account `[prefix-]number/bankcode` */
  cpAccount?: string;
  cpName?: string;
  merchant?: string;
  city?: string;
  vs?: string;
  ks?: string;
  ss?: string;
  message?: string;
  note?: string;
  /** the bank's own transaction type, e.g. "Platba kartou" */
  bankType: string;
  /** coarse category assigned by the bank (RB) */
  bankCategory?: string;
  bankTxId?: string;
  /** where the transaction was read from: the CSV export, a PDF statement or both */
  source?: TxSource;
}

export type TxSource = 'csv' | 'pdf' | 'both';

/** Summary of one bank statement (RB PDF): used to check that no movement is missing. */
export interface StatementSummary {
  /** statement number within the year ("poř. č.") */
  seq: number;
  /** inclusive ISO dates */
  from: string;
  to: string;
  opening: number;
  closing: number;
  /** sum of incoming movements (positive) */
  income: number;
  /** sum of outgoing movements (positive) */
  expense: number;
  fees: number;
  txCount: number;
}

export interface BalancePoint {
  /** balance at the end of this day (ISO) */
  date: string;
  balance: number;
}

export interface BankAccountData {
  /** `<number>/<bank code>` */
  id: string;
  bank: Bank;
  number: string;
  /** account name stated in the export (e.g. RB "Název účtu") */
  name?: string;
  currency: string;
  /** balances stated in statements (Fio, KB) */
  balancePoints: BalancePoint[];
}

export interface BankLedger {
  accounts: Map<string, BankAccountData>;
  txs: BankTx[];
  warnings: { source: string; message: string }[];
}

export function emptyBankLedger(): BankLedger {
  return { accounts: new Map(), txs: [], warnings: [] };
}
