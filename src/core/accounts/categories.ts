/**
 * Categorisation of bank transactions. Pure and deterministic. Layers, first match wins:
 *   1. manual assignment of the transaction (override)
 *   2. user rules (mostly created with one click when a whole counterparty group is assigned)
 *   3. internal transfers / investments (flow classification)
 *   4. the bank's own transaction type (interest, interest tax, fees, ATM)
 *   5. built-in dictionary of Czech merchants and keywords
 *   6. learned: the same counterparty was assigned manually before (a suggestion)
 *   7. uncategorised
 * Nothing leaves the computer – no external service is used.
 */
import { normAccount } from './accountNumber.js';
import type { TxFlow } from './analytics.js';
import type { BankTx } from './types.js';

export type CategoryKind = 'expense' | 'income' | 'neutral';

export interface Category {
  /** stable id (`[a-z0-9-]`) */
  id: string;
  name: string;
  kind: CategoryKind;
}

/** Id of a transaction without a category (not stored as a category). */
export const UNCATEGORIZED = '';
/** Neutral categories that the flow classification assigns. */
export const TRANSFER = 'transfer';
export const INVESTMENT = 'investment';

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'groceries', name: 'Potraviny', kind: 'expense' },
  { id: 'eating-out', name: 'Jídlo venku', kind: 'expense' },
  { id: 'housing', name: 'Bydlení a energie', kind: 'expense' },
  { id: 'transport', name: 'Doprava', kind: 'expense' },
  { id: 'health', name: 'Zdraví', kind: 'expense' },
  { id: 'shopping', name: 'Nákupy', kind: 'expense' },
  { id: 'subscriptions', name: 'Předplatné a služby', kind: 'expense' },
  { id: 'travel', name: 'Cestování', kind: 'expense' },
  { id: 'kids', name: 'Děti', kind: 'expense' },
  { id: 'gifts', name: 'Dárky', kind: 'expense' },
  { id: 'fees', name: 'Poplatky', kind: 'expense' },
  { id: 'cash', name: 'Hotovost', kind: 'expense' },
  { id: 'taxes', name: 'Daně', kind: 'expense' },
  { id: 'other-expense', name: 'Ostatní výdaje', kind: 'expense' },
  { id: 'salary', name: 'Mzda', kind: 'income' },
  { id: 'business', name: 'Podnikatelská činnost', kind: 'income' },
  { id: 'gifts-received', name: 'Dary', kind: 'income' },
  { id: 'interest', name: 'Úroky', kind: 'income' },
  { id: 'other-income', name: 'Ostatní příjmy', kind: 'income' },
  { id: TRANSFER, name: 'Převod mezi účty', kind: 'neutral' },
  { id: INVESTMENT, name: 'Investice', kind: 'neutral' },
];

export interface RuleMatch {
  /** counterparty account (normalised `[prefix-]number/bank`) */
  cpAccount?: string;
  /**
   * normalised counterparty name (see `cpName`), matched exactly; without `cpAccount` it applies only
   * to transactions without a counterparty account (the same grouping as `cpKey`)
   */
  name?: string;
  /** normalised text contained in the counterparty, merchant, message or note */
  text?: string;
  direction?: 'in' | 'out';
  /** own account the rule is limited to */
  accountId?: string;
}

export interface CategoryRule {
  id: string;
  category: string;
  match: RuleMatch;
}

export type CategorySource = 'manual' | 'rule' | 'flow' | 'bank' | 'dictionary' | 'learned' | 'none';

export interface CategoryResult {
  category: string;
  source: CategorySource;
  /** short Czech explanation for the UI */
  reason: string;
  ruleId?: string;
}

/** Upper case, without diacritics and punctuation, single spaces. */
export function normText(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalised counterparty name: the merchant (card payments) or the counterparty name, without
 * numbers (store or terminal ids) and legal form suffixes, at most three words.
 * "ALBERT HYPERMARKET 1234" and "Albert Hypermarket 0456" -> "ALBERT HYPERMARKET".
 */
export function cpName(t: Pick<BankTx, 'merchant' | 'cpName'>): string {
  const words = normText(t.merchant ?? t.cpName)
    .replace(/\b\d+\b/g, ' ')
    .split(' ')
    .filter((w) => w && !['SRO', 'S', 'R', 'O', 'AS', 'A', 'SE', 'AG', 'GMBH', 'LTD', 'INC', 'SPOL', 'CZ', 'COM', 'WWW'].includes(w));
  return words.slice(0, 3).join(' ');
}

/** Counterparty identity used to group transactions and to learn from manual assignments. */
export function cpKey(t: Pick<BankTx, 'merchant' | 'cpName' | 'cpAccount' | 'bankType'>): string {
  const acc = normAccount(t.cpAccount);
  if (acc) return `acc:${acc}`;
  const name = cpName(t);
  if (name) return `name:${name}`;
  return `type:${normText(t.bankType)}`;
}

/** Normalised parts of a transaction that rules look at (computed once per transaction). */
export interface PreparedTx {
  account?: string;
  name: string;
  /** ` TEXT ` padded with spaces for whole-word search */
  hay: string;
}

export function prepareTx(t: BankTx): PreparedTx {
  return { account: normAccount(t.cpAccount), name: cpName(t), hay: ` ${normText([t.merchant, t.cpName, t.message, t.note].filter(Boolean).join(' '))} ` };
}

export function ruleMatches(r: RuleMatch, t: BankTx, p: PreparedTx = prepareTx(t)): boolean {
  if (!r.cpAccount && !r.name && !r.text) return false; // a rule must say something about the counterparty
  if (r.direction === 'in' && t.amount < 0) return false;
  if (r.direction === 'out' && t.amount >= 0) return false;
  if (r.accountId && r.accountId !== t.accountId) return false;
  if (r.cpAccount && p.account !== r.cpAccount) return false;
  if (r.name && (p.name !== r.name || (!r.cpAccount && p.account))) return false;
  if (r.text && !p.hay.includes(` ${r.text} `)) return false;
  return true;
}

/** Identity of a rule condition (two rules with the same signature match the same transactions). */
export function ruleSignature(m: RuleMatch): string {
  return JSON.stringify([m.cpAccount ?? '', m.name ?? '', m.text ?? '', m.direction ?? '', m.accountId ?? '']);
}

/** Human readable description of a rule (Czech). */
export function describeRule(r: RuleMatch): string {
  const parts: string[] = [];
  if (r.cpAccount) parts.push(`protiúčet ${r.cpAccount}`);
  if (r.name) parts.push(`protistrana „${r.name}“`);
  if (r.text) parts.push(`text obsahuje „${r.text}“`);
  if (r.direction) parts.push(r.direction === 'in' ? 'jen příchozí' : 'jen odchozí');
  if (r.accountId) parts.push(`jen účet ${r.accountId}`);
  return parts.join(', ');
}

/** The bank's own transaction type */
function bankCategory(t: BankTx): CategoryResult | null {
  const type = `${t.bankType} ${t.bankCategory ?? ''}`;
  const why = `typ transakce v bance: ${t.bankType || t.bankCategory}`;
  // `\b` does not work after non-ASCII letters (Daň), hence explicit word ends
  if (/daň z úroků|odvod daně|(^|\s)daň(\s|$)|daň z příjmů/i.test(type)) return { category: 'taxes', source: 'bank', reason: why };
  if (/úrok/i.test(type)) return { category: t.amount >= 0 ? 'interest' : 'fees', source: 'bank', reason: why };
  if (/poplat/i.test(type)) return { category: 'fees', source: 'bank', reason: why };
  // "Bezhotovostní platba/příjem" are ordinary transfers, not cash
  if (t.amount < 0 && /bankomat|výběr hotovosti|(?<!bez)hotovost/i.test(type)) return { category: 'cash', source: 'bank', reason: why };
  return null;
}

/**
 * Built-in dictionary: normalised keyword (whole words) -> category. Matched against the merchant
 * and counterparty name (and the message of card payments). Order matters: the first hit wins.
 */
export const MERCHANT_DICTIONARY: [string, string][] = [
  // groceries
  ...['ALBERT', 'LIDL', 'KAUFLAND', 'BILLA', 'PENNY', 'TESCO', 'GLOBUS', 'ROHLIK', 'KOSIK', 'COOP', 'NORMA', 'ZABKA', 'JIP', 'HRUSKA', 'MAKRO', 'POTRAVINY', 'PEKARNA', 'RESKO'].map(
    (k) => [k, 'groceries'] as [string, string],
  ),
  // eating out
  ...['WOLT', 'FOODORA', 'DAMEJIDLO', 'BOLT FOOD', 'MCDONALDS', 'MC DONALDS', 'KFC', 'BURGER KING', 'STARBUCKS', 'COSTA COFFEE', 'BAGETERIE', 'RESTAURACE', 'BISTRO', 'KAVARNA', 'PIZZERIA', 'CAFE', 'HOSPODA', 'PIVNICE'].map(
    (k) => [k, 'eating-out'] as [string, string],
  ),
  // transport
  ...['SHELL', 'OMV', 'MOL', 'BENZINA', 'ORLEN', 'EUROOIL', 'CEPRO', 'CESKE DRAHY', 'CD CZ', 'REGIOJET', 'LEO EXPRESS', 'FLIXBUS', 'BOLT', 'UBER', 'LIFTAGO', 'DPP', 'PID', 'LITACKA', 'PARKING', 'PARKOVANI', 'DALNICNI', 'EDALNICE', 'UNIPETROL'].map(
    (k) => [k, 'transport'] as [string, string],
  ),
  // health
  ...['DR MAX', 'BENU', 'LEKARNA', 'PHARMACY', 'NEMOCNICE', 'POLIKLINIKA', 'ZUBNI', 'MUDR'].map((k) => [k, 'health'] as [string, string]),
  // subscriptions and services
  ...['NETFLIX', 'SPOTIFY', 'HBO', 'DISNEY', 'APPLE COM BILL', 'GOOGLE', 'YOUTUBE', 'MICROSOFT', 'ADOBE', 'GITHUB', 'OPENAI', 'O2', 'T MOBILE', 'VODAFONE', 'UPC'].map(
    (k) => [k, 'subscriptions'] as [string, string],
  ),
  // housing and energy
  ...['CEZ', 'PRE', 'INNOGY', 'E ON', 'EON', 'PRAZSKA PLYNARENSKA', 'PRAZSKE VODOVODY', 'VEOLIA', 'BYTOVE DRUZSTVO', 'SVJ', 'NAJEM', 'NAJEMNE', 'IKEA', 'HORNBACH', 'OBI', 'BAUHAUS'].map(
    (k) => [k, 'housing'] as [string, string],
  ),
  // shopping
  ...['ALZA', 'MALL', 'CZC', 'DATART', 'ELECTRO WORLD', 'AMAZON', 'ALIEXPRESS', 'TEMU', 'ZALANDO', 'H M', 'ZARA', 'DM DROGERIE', 'ROSSMANN', 'TETA', 'DECATHLON', 'SPORTISIMO', 'NOTINO', 'KNIHY DOBROVSKY', 'LUXOR'].map(
    (k) => [k, 'shopping'] as [string, string],
  ),
  // travel
  ...['BOOKING', 'AIRBNB', 'RYANAIR', 'WIZZ', 'EASYJET', 'SMARTWINGS', 'CSA', 'LETISTE', 'AIRPORT', 'FLUGHAFEN', 'HOTEL', 'INVIA', 'CEDOK'].map((k) => [k, 'travel'] as [string, string]),
  // kids
  ...['SKOLKA', 'SKOLNE', 'KROUZEK', 'HRACKY', 'BAMBULE'].map((k) => [k, 'kids'] as [string, string]),
  // taxes
  ...['FINANCNI URAD', 'CSSZ', 'SPRAVA SOCIALNIHO'].map((k) => [k, 'taxes'] as [string, string]),
  // income
  ...['MZDA', 'VYPLATA', 'PLAT', 'SALARY', 'ODMENA'].map((k) => [k, 'salary'] as [string, string]),
];

function dictionaryCategory(t: BankTx): CategoryResult | null {
  const card = /kart/i.test(`${t.bankType} ${t.bankCategory ?? ''}`);
  const names = ` ${normText([t.merchant, t.cpName].filter(Boolean).join(' '))} `;
  const text = ` ${normText([t.message, t.note].filter(Boolean).join(' '))} `;
  for (const [k, cat] of MERCHANT_DICTIONARY) {
    const income = cat === 'salary';
    // salary keywords are looked up in the payment message, merchants in the names
    const hay = income ? text : card ? `${names}${text}` : names;
    // incoming: salary, or a card refund from a merchant (it lowers the merchant's category)
    if (income ? t.amount < 0 : t.amount >= 0 && !card) continue;
    if (hay.includes(` ${k} `)) return { category: cat, source: 'dictionary', reason: `obsahuje „${k}“ (vestavěný slovník)` };
  }
  return null;
}

export interface CategorizeContext {
  categories: Category[];
  rules: CategoryRule[];
  overrides: Record<string, string>;
}

/** Category of every transaction (keyed by `BankTx.key`). */
export function categorize(txs: readonly (BankTx & { flow: TxFlow })[], ctx: CategorizeContext): Map<string, CategoryResult> {
  const known = new Set(ctx.categories.map((c) => c.id));
  const name = new Map(ctx.categories.map((c) => [c.id, c.name]));
  const rules = ctx.rules.filter((r) => known.has(r.category));
  const kindOf = new Map(ctx.categories.map((c) => [c.id, c.kind]));
  // a transfer between own accounts (or to an investment account) is never income or expense by a rule;
  // only a manual assignment can do that
  const neutralRules = rules.filter((r) => kindOf.get(r.category) === 'neutral');
  // learned: counterparty -> categories assigned manually (most frequent wins, ties by name)
  const learnedVotes = new Map<string, Map<string, number>>();
  for (const t of txs) {
    const c = ctx.overrides[t.key];
    if (!c || !known.has(c)) continue;
    const ck = cpKey(t);
    if (ck.startsWith('type:')) continue; // without a counterparty there is nothing to learn from
    const k = `${t.amount >= 0 ? 'in' : 'out'}|${ck}`;
    const votes = learnedVotes.get(k) ?? new Map<string, number>();
    votes.set(c, (votes.get(c) ?? 0) + 1);
    learnedVotes.set(k, votes);
  }
  const learned = new Map<string, string>();
  for (const [k, votes] of learnedVotes) learned.set(k, [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]);

  const out = new Map<string, CategoryResult>();
  for (const t of txs) {
    const manual = ctx.overrides[t.key];
    let r: CategoryResult | null = null;
    if (manual !== undefined && (manual === UNCATEGORIZED || known.has(manual))) r = { category: manual, source: 'manual', reason: 'zařazeno ručně' };
    if (!r && rules.length) {
      const p = prepareTx(t);
      const rule = (t.flow === 'transfer' || t.flow === 'investment' ? neutralRules : rules).find((x) => ruleMatches(x.match, t, p));
      if (rule) r = { category: rule.category, source: 'rule', reason: `pravidlo: ${describeRule(rule.match)}`, ruleId: rule.id };
    }
    if (!r && t.flow === 'transfer' && known.has(TRANSFER)) r = { category: TRANSFER, source: 'flow', reason: 'převod mezi vlastními účty' };
    if (!r && t.flow === 'investment' && known.has(INVESTMENT)) r = { category: INVESTMENT, source: 'flow', reason: 'převod na investiční účet' };
    if (!r) r = bankCategory(t);
    if (!r) r = dictionaryCategory(t);
    if (r && r.source !== 'manual' && !known.has(r.category)) r = null; // the user deleted the category
    if (!r) {
      const l = t.flow === 'transfer' || t.flow === 'investment' ? undefined : learned.get(`${t.amount >= 0 ? 'in' : 'out'}|${cpKey(t)}`);
      if (l) r = { category: l, source: 'learned', reason: `návrh: stejnou protistranu jste zařadili jako „${name.get(l)}“` };
    }
    out.set(t.key, r ?? { category: UNCATEGORIZED, source: 'none', reason: 'nezařazeno' });
  }
  return out;
}

const ID_RE = /^[a-z0-9-]{1,40}$/;

/** Categories that cannot be deleted or change their kind (see `sanitizeCategories`). */
export const LOCKED = new Set([TRANSFER, INVESTMENT]);

export function sanitizeCategories(raw: unknown): Category[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Category[] = [];
  const seen = new Set<string>();
  for (const v of raw.slice(0, 200)) {
    if (!v || typeof v !== 'object') continue;
    const c = v as Record<string, unknown>;
    if (typeof c.id !== 'string' || !ID_RE.test(c.id) || seen.has(c.id)) continue;
    if (typeof c.name !== 'string' || !c.name.trim()) continue;
    const kind = c.kind === 'income' || c.kind === 'neutral' ? c.kind : 'expense';
    seen.add(c.id);
    out.push({ id: c.id, name: c.name.trim().slice(0, 60), kind: LOCKED.has(c.id) ? 'neutral' : kind });
  }
  // the flow classification relies on them (no double counting of own transfers)
  for (const c of DEFAULT_CATEGORIES) if (LOCKED.has(c.id) && !seen.has(c.id)) out.push({ ...c });
  return out;
}

function cleanNorm(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const n = normText(v).slice(0, 80);
  return n || undefined;
}

export const MAX_RULES = 2000;

export function sanitizeRules(raw: unknown, categoryIds: Set<string>): CategoryRule[] {
  if (!Array.isArray(raw)) return [];
  const out: CategoryRule[] = [];
  const ids = new Set<string>();
  for (const v of raw.slice(0, MAX_RULES)) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== 'string' || !ID_RE.test(r.id) || ids.has(r.id) || typeof r.category !== 'string' || !categoryIds.has(r.category)) continue;
    const m = (r.match ?? {}) as Record<string, unknown>;
    const match: RuleMatch = {};
    const acc = typeof m.cpAccount === 'string' ? normAccount(m.cpAccount) : undefined;
    if (acc) match.cpAccount = acc;
    const name = cleanNorm(m.name);
    if (name) match.name = name;
    const text = cleanNorm(m.text);
    if (text) match.text = text;
    if (m.direction === 'in' || m.direction === 'out') match.direction = m.direction;
    if (typeof m.accountId === 'string' && /^[\d-]{1,40}\/\d{4}$/.test(m.accountId)) match.accountId = m.accountId;
    if (!match.cpAccount && !match.name && !match.text) continue;
    ids.add(r.id);
    out.push({ id: r.id, category: r.category, match });
  }
  return out;
}

export function sanitizeOverrides(raw: unknown, categoryIds: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 100000) break;
    if (k.length > 200 || !/^(FIO|KB|RB):/.test(k) || typeof v !== 'string') continue;
    if (v !== UNCATEGORIZED && !categoryIds.has(v)) continue;
    out[k] = v;
    n++;
  }
  return out;
}

/** Rule that assigns the whole counterparty group of `t` (used by "assign all similar"). */
export function ruleForGroup(t: Pick<BankTx, 'merchant' | 'cpName' | 'cpAccount' | 'bankType' | 'amount'>, category: string, id: string): CategoryRule | null {
  const acc = normAccount(t.cpAccount);
  const name = cpName(t);
  const direction = t.amount >= 0 ? 'in' : 'out';
  if (acc) return { id, category, match: { cpAccount: acc, direction } };
  if (name) return { id, category, match: { name, direction } };
  return null;
}
