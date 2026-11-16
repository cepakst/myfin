/**
 * Accounts module analytics: internal transfers, product types, balance history and monthly
 * income/expense. Pure and deterministic – amounts in foreign currencies are converted with the
 * converter passed in.
 */
import { addDays } from '../util.js';
import { mergeBalances } from './balances.js';
import { BANK_NAME, type BalancePoint, type Bank, type BankAccountData, type BankLedger, type BankTx, type ProductType } from './types.js';

/** How a movement counts in the statistics */
export type TxFlow = 'income' | 'expense' | 'transfer' | 'investment';

export interface OwnAccount {
  /** `[prefix-]number/bankcode` */
  account: string;
  label?: string;
  /** 'investment' = broker or investment account: money sent there is invested, not spent */
  kind: 'own' | 'investment';
}

export interface AccountConfig {
  alias?: string;
  product?: ProductType;
  hidden?: boolean;
  /** balance entered by the user (end of day), for banks whose exports carry no balance */
  anchor?: BalancePoint;
}

export interface AccountsConfig {
  version: 1;
  accounts: Record<string, AccountConfig>;
  /** accounts outside the imported banks that belong to the user (other banks, brokers) */
  ownAccounts: OwnAccount[];
}

export function defaultAccountsConfig(): AccountsConfig {
  return { version: 1, accounts: {}, ownAccounts: [] };
}

const PRODUCTS: ProductType[] = ['current', 'savings', 'term', 'credit', 'other'];

/** Validates a config read from disk or sent by the UI; unknown or malformed parts are dropped. */
export function sanitizeAccountsConfig(raw: unknown): AccountsConfig {
  const out = defaultAccountsConfig();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.accounts && typeof r.accounts === 'object') {
    for (const [id, v] of Object.entries(r.accounts as Record<string, unknown>).slice(0, 500)) {
      if (!v || typeof v !== 'object' || !/^[\d-]{1,40}\/\d{4}$/.test(id)) continue;
      const a = v as Record<string, unknown>;
      const c: AccountConfig = {};
      if (typeof a.alias === 'string' && a.alias.trim()) c.alias = a.alias.trim().slice(0, 80);
      if (typeof a.product === 'string' && PRODUCTS.includes(a.product as ProductType)) c.product = a.product as ProductType;
      if (a.hidden === true) c.hidden = true;
      const an = a.anchor as Record<string, unknown> | undefined;
      if (an && typeof an.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(an.date) && typeof an.balance === 'number' && Number.isFinite(an.balance)) {
        c.anchor = { date: an.date, balance: an.balance };
      }
      if (Object.keys(c).length) out.accounts[id] = c;
    }
  }
  if (Array.isArray(r.ownAccounts)) {
    for (const v of r.ownAccounts.slice(0, 200)) {
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      const account = typeof o.account === 'string' ? normAccount(o.account) : undefined;
      if (!account) continue;
      out.ownAccounts.push({
        account,
        label: typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 80) : undefined,
        kind: o.kind === 'investment' ? 'investment' : 'own',
      });
    }
  }
  return out;
}

/** Czech account number `[prefix-]number/bankcode` without leading zeros, or undefined. */
export function normAccount(raw: string | undefined): string | undefined {
  const m = /^\s*(?:(\d{1,6})\s*-\s*)?(\d{2,10})\s*\/\s*(\d{4})\s*$/.exec(raw ?? '');
  if (!m) return undefined;
  const prefix = (m[1] ?? '').replace(/^0+/, '');
  const number = m[2].replace(/^0+/, '');
  return `${prefix ? `${prefix}-` : ''}${number}/${m[3]}`;
}

/** Brokers whose accounts receive investment deposits (matched on the counterparty name) */
// no word boundary around degiro/flatex: the counterparty is usually "flatexDEGIRO Bank AG"
const BROKER_NAME = /degiro|flatex|\b(xtb|x-trade|interactive brokers|trading 212|revolut securities|portu|fondee|patria|conseq|amundi)\b/i;
/** Transfers between the current and savings account of the same bank, without a counterparty number */
const INTERNAL_TYPE = /převod prostředků (ze|na) spoři[cč]í účet|převod mezi (svými|vlastními) účty/i;

export interface FlowInfo {
  flow: TxFlow;
  /** own account on the other side (internal transfer) */
  otherAccount?: string;
}

/** Classifies each transaction as income, expense, internal transfer or investment. */
export function classifyFlows(txs: readonly BankTx[], ledgerAccounts: Iterable<string>, own: readonly OwnAccount[]): Map<string, FlowInfo> {
  const ownSet = new Map<string, OwnAccount['kind']>();
  for (const a of ledgerAccounts) {
    const n = normAccount(a);
    if (n) ownSet.set(n, 'own');
  }
  for (const o of own) ownSet.set(o.account, o.kind);
  const out = new Map<string, FlowInfo>();
  for (const t of txs) {
    const cp = normAccount(t.cpAccount);
    const kind = cp ? ownSet.get(cp) : undefined;
    let info: FlowInfo;
    if (kind === 'investment' || (!kind && BROKER_NAME.test(`${t.cpName ?? ''} ${t.merchant ?? ''}`) && (!!cp || (/převod|úhrada|platba/i.test(t.bankType) && !CARD_TYPE.test(t.bankType))))) info = { flow: 'investment', otherAccount: cp };
    else if (kind === 'own' && cp !== normAccount(t.accountId)) info = { flow: 'transfer', otherAccount: cp };
    else if (INTERNAL_TYPE.test(t.bankType)) info = { flow: 'transfer' };
    else info = { flow: t.amount >= 0 ? 'income' : 'expense' };
    out.set(t.key, info);
  }
  return out;
}

const INTEREST_TYPE = /úrok|daň z úroků|odvod daně/i;
const CARD_TYPE = /kartou|karty|bankomat/i;

/** Product type guessed from the account name and its movements. */
export function inferProduct(account: Pick<BankAccountData, 'name'>, txs: readonly BankTx[]): ProductType {
  const name = account.name ?? '';
  if (/spoři|spoření|savings/i.test(name) && !/běžn/i.test(name)) return 'savings';
  if (/termín/i.test(name)) return 'term';
  if (/kredit|credit|úvěr/i.test(name)) return 'credit';
  if (/běžn|osobní|konto|current/i.test(name)) return 'current';
  if (txs.length === 0) return 'current';
  const interest = txs.filter((t) => INTEREST_TYPE.test(t.bankType)).length;
  const cards = txs.filter((t) => CARD_TYPE.test(t.bankType)).length;
  // a savings account is mostly interest and transfers, never card payments
  return interest >= 2 && cards === 0 && interest / txs.length >= 0.2 ? 'savings' : 'current';
}

export interface BalanceSeries {
  /** end-of-day balance at `date` */
  at: (date: string) => number;
  /** balances come from the bank or the user (false = movements summed from zero) */
  anchored: boolean;
  /** stated balances that do not match the movements (a missing statement) */
  mismatches: { from: string; to: string; difference: number }[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Balance of an account over time from the anchors (stated balances) and the movements. Each date
 * uses the nearest preceding anchor (or the first following one) plus/minus the movements between.
 */
export function balanceSeries(txs: readonly BankTx[], anchors: readonly BalancePoint[]): BalanceSeries {
  const byDate = new Map<string, number>();
  for (const t of txs) byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.amount);
  const dates = [...byDate.keys()].sort();
  // cumulative sum of movements up to and including each date
  const cum: number[] = [];
  let s = 0;
  for (const d of dates) {
    s += byDate.get(d)!;
    cum.push(s);
  }
  const cumAt = (date: string): number => {
    let lo = 0;
    let hi = dates.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= date) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return idx < 0 ? 0 : cum[idx];
  };
  const sorted = [...anchors].sort((a, b) => (a.date < b.date ? -1 : 1));
  const mismatches: BalanceSeries['mismatches'] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const diff = round2(b.balance - (a.balance + cumAt(b.date) - cumAt(a.date)));
    if (Math.abs(diff) >= 0.01) mismatches.push({ from: addDays(a.date, 1), to: b.date, difference: diff });
  }
  const at = (date: string): number => {
    if (!sorted.length) return round2(cumAt(date));
    let anchor = sorted[0];
    for (const a of sorted) if (a.date <= date) anchor = a;
    return round2(anchor.balance + cumAt(date) - cumAt(anchor.date));
  };
  return { at, anchored: sorted.length > 0, mismatches };
}

/** 'YYYY-MM' of every month from `from` to `to` (inclusive) */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function monthEnd(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** amount (in `currency`) -> CZK on `date`; null when no rate is known */
export type CzkConverter = (amount: number, currency: string, date: string) => number | null;

export interface AccountView {
  id: string;
  bank: Bank;
  bankName: string;
  number: string;
  /** alias, or the name from the export, or the number */
  displayName: string;
  exportName?: string;
  alias?: string;
  product: ProductType;
  productInferred: ProductType;
  currency: string;
  hidden: boolean;
  /** balance on the last day of data (or today) in the account currency */
  balance: number;
  /** null when the currency cannot be converted */
  balanceCzk: number | null;
  balanceDate: string;
  /** false = no stated balance; the balance is the sum of movements from zero */
  anchored: boolean;
  anchor?: BalancePoint;
  firstDate?: string;
  lastDate?: string;
  txCount: number;
  /** month-end balances in CZK (null = not convertible) */
  monthly: { month: string; balance: number; balanceCzk: number | null }[];
}

export interface TxView extends BankTx {
  flow: TxFlow;
  otherAccount?: string;
  amountCzk: number | null;
  accountName: string;
}

export interface MonthFlows {
  month: string;
  income: number;
  expense: number;
  /** income - expense */
  net: number;
  /** sent to investment accounts (net) */
  invested: number;
  /** total balance at month end (visible accounts, CZK) */
  balance: number;
}

export interface AccountsSummary {
  accounts: AccountView[];
  txs: TxView[];
  months: MonthFlows[];
  totals: {
    balanceCzk: number;
    /** last 12 complete or running months */
    income12m: number;
    expense12m: number;
    savingsRate12m: number | null;
    invested12m: number;
  };
  warnings: { source: string; message: string }[];
}

/**
 * Everything the accounts pages show. Hidden accounts keep their transactions in the list but are
 * left out of balances and statistics.
 */
export function summarizeAccounts(ledger: BankLedger, config: AccountsConfig, today: string, toCzk: CzkConverter): AccountsSummary {
  const warnings = [...ledger.warnings];
  const flows = classifyFlows(ledger.txs, ledger.accounts.keys(), config.ownAccounts);
  const txsByAcc = new Map<string, BankTx[]>();
  for (const t of ledger.txs) {
    const l = txsByAcc.get(t.accountId);
    if (l) l.push(t);
    else txsByAcc.set(t.accountId, [t]);
  }
  const allDates = ledger.txs.map((t) => t.date);
  for (const a of ledger.accounts.values()) for (const p of a.balancePoints) allDates.push(p.date);
  allDates.sort();
  const lastDataDate = allDates.at(-1) ?? today;
  const endDate = lastDataDate > today ? lastDataDate : today;
  const months = allDates.length ? monthsBetween(allDates[0], endDate) : [];
  const czk = (amount: number, currency: string, date: string): number | null => (currency === 'CZK' ? amount : toCzk(amount, currency, date));

  const accounts: AccountView[] = [];
  for (const a of [...ledger.accounts.values()].sort((x, y) => (x.bank === y.bank ? (x.number < y.number ? -1 : 1) : x.bank < y.bank ? -1 : 1))) {
    const cfg = config.accounts[a.id] ?? {};
    const txs = txsByAcc.get(a.id) ?? [];
    // the balance entered by the user wins over a statement balance on the same day
    const anchors = mergeBalances(a.balancePoints, cfg.anchor ? [cfg.anchor] : []);
    const series = balanceSeries(txs, anchors);
    const label = cfg.alias ?? a.name ?? `${BANK_NAME[a.bank]} ${a.number}`;
    for (const m of series.mismatches) {
      warnings.push({ source: label, message: `Zůstatky z výpisů nesedí s pohyby v období ${m.from} – ${m.to} (rozdíl ${m.difference.toFixed(2)} ${a.currency}). Pravděpodobně chybí výpis.` });
    }
    const dates = txs.map((t) => t.date).sort();
    const firstKnown = [dates[0], anchors[0]?.date].filter((x): x is string => !!x).sort()[0];
    const inferred = inferProduct(a, txs);
    const balance = series.at(endDate);
    accounts.push({
      id: a.id,
      bank: a.bank,
      bankName: BANK_NAME[a.bank],
      number: a.number,
      displayName: label,
      exportName: a.name,
      alias: cfg.alias,
      product: cfg.product ?? inferred,
      productInferred: inferred,
      currency: a.currency,
      hidden: !!cfg.hidden,
      balance,
      balanceCzk: czk(balance, a.currency, endDate),
      balanceDate: endDate,
      anchored: series.anchored,
      anchor: cfg.anchor,
      firstDate: dates[0],
      lastDate: dates.at(-1),
      txCount: txs.length,
      monthly: months.map((m) => {
        const d = monthEnd(m) < endDate ? monthEnd(m) : endDate;
        // nothing is known about the account before its first statement or movement
        const b = firstKnown && d < firstKnown ? 0 : series.at(d);
        return { month: m, balance: b, balanceCzk: czk(b, a.currency, d) };
      }),
    });
    if (!series.anchored && txs.length) {
      warnings.push({ source: label, message: 'Export neobsahuje zůstatek – zůstatek je jen součet pohybů od nuly. Zadejte aktuální zůstatek v Nastavení.' });
    }
  }
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const visible = new Set(accounts.filter((a) => !a.hidden).map((a) => a.id));

  const txs: TxView[] = ledger.txs
    .map((t) => {
      const f = flows.get(t.key)!;
      return { ...t, flow: f.flow, otherAccount: f.otherAccount, amountCzk: czk(t.amount, t.currency, t.date), accountName: accById.get(t.accountId)?.displayName ?? t.accountId };
    })
    .sort((a, b) => (a.date === b.date ? (a.key < b.key ? 1 : -1) : a.date < b.date ? 1 : -1));

  const mIndex = new Map(months.map((m, i) => [m, i]));
  const monthFlows: MonthFlows[] = months.map((m, i) => ({
    month: m,
    income: 0,
    expense: 0,
    net: 0,
    invested: 0,
    balance: accounts.filter((a) => visible.has(a.id)).reduce((s, a) => s + (a.monthly[i].balanceCzk ?? 0), 0),
  }));
  for (const t of txs) {
    if (!visible.has(t.accountId) || t.amountCzk === null) continue;
    const mf = monthFlows[mIndex.get(t.date.slice(0, 7))!];
    if (!mf) continue;
    if (t.flow === 'income') mf.income += t.amountCzk;
    else if (t.flow === 'expense') mf.expense -= t.amountCzk;
    else if (t.flow === 'investment') mf.invested -= t.amountCzk;
  }
  for (const mf of monthFlows) {
    mf.income = round2(mf.income);
    mf.expense = round2(mf.expense);
    mf.invested = round2(mf.invested);
    mf.net = round2(mf.income - mf.expense);
    mf.balance = round2(mf.balance);
  }
  const last12 = monthFlows.filter((m) => m.month <= endDate.slice(0, 7)).slice(-12);
  const income12m = round2(last12.reduce((s, m) => s + m.income, 0));
  const expense12m = round2(last12.reduce((s, m) => s + m.expense, 0));
  const invested12m = round2(last12.reduce((s, m) => s + m.invested, 0));
  const unconvertible = accounts.filter((a) => !a.hidden && a.balanceCzk === null);
  for (const a of unconvertible) warnings.push({ source: a.displayName, message: `Pro měnu ${a.currency} není k dispozici kurz ČNB – účet není započten do celkového zůstatku v Kč.` });
  return {
    accounts,
    txs,
    months: monthFlows,
    totals: {
      balanceCzk: round2(accounts.filter((a) => !a.hidden).reduce((s, a) => s + (a.balanceCzk ?? 0), 0)),
      income12m,
      expense12m,
      savingsRate12m: income12m > 0 ? (income12m - expense12m) / income12m : null,
      invested12m,
    },
    warnings,
  };
}
