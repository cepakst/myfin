import { describe, expect, it } from 'vitest';
import {
  categorize,
  cpKey,
  cpName,
  DEFAULT_CATEGORIES,
  describeRule,
  LOCKED,
  MAX_RULES,
  MERCHANT_DICTIONARY,
  normText,
  prepareTx,
  ruleForGroup,
  ruleMatches,
  ruleSignature,
  sanitizeCategories,
  sanitizeOverrides,
  sanitizeRules,
  type Category,
  type CategorizeContext,
  type CategoryRule,
} from '../src/core/accounts/categories.js';
import type { TxFlow } from '../src/core/accounts/analytics.js';
import type { BankTx } from '../src/core/accounts/types.js';

const KB = '111111/0100';
let seq = 0;
type T = BankTx & { flow: TxFlow };
function tx(amount: number, extra: Partial<T> = {}): T {
  seq++;
  return { key: `KB:${KB}:${seq}`, bank: 'KB', accountId: KB, date: '2025-03-10', amount, currency: 'CZK', bankType: 'Odchozí úhrada', flow: amount < 0 ? 'expense' : 'income', ...extra };
}
const ctx = (extra: Partial<CategorizeContext> = {}): CategorizeContext => ({ categories: DEFAULT_CATEGORIES, rules: [], overrides: {}, ...extra });
const cat1 = (t: T, c: Partial<CategorizeContext> = {}) => categorize([t], ctx(c)).get(t.key)!;
const LOCKED_DEFAULTS = DEFAULT_CATEGORIES.filter((c) => c.id === 'transfer' || c.id === 'investment');
const rule = (id: string, category: string, match: CategoryRule['match']): CategoryRule => ({ id, category, match });

describe('normText / cpName / cpKey', () => {
  it('normText removes diacritics, punctuation and case', () => {
    expect(normText('  Rohlík.cz, a.s.! ')).toBe('ROHLIK CZ A S');
    expect(normText(undefined)).toBe('');
  });

  it('cpName strips numbers and legal forms and keeps at most three words', () => {
    expect(cpName({ merchant: 'ALBERT HYPERMARKET 1234' })).toBe('ALBERT HYPERMARKET');
    expect(cpName({ merchant: 'Albert Hypermarket 0456' })).toBe('ALBERT HYPERMARKET');
    expect(cpName({ cpName: 'ACME TEST S.R.O.' })).toBe('ACME TEST');
    expect(cpName({ cpName: 'Foo Bar Baz Qux GmbH' })).toBe('FOO BAR BAZ');
    expect(cpName({ merchant: 'WWW.ALZA.CZ' })).toBe('ALZA');
    expect(cpName({})).toBe('');
  });

  it('cpName prefers the merchant over the counterparty name', () => {
    expect(cpName({ merchant: 'SHELL', cpName: 'Something else' })).toBe('SHELL');
  });

  it('cpKey prefers the normalised account, then the name, then the bank type', () => {
    expect(cpKey({ cpAccount: '0000123456/0800', cpName: 'X', bankType: 'Platba' })).toBe('acc:123456/0800');
    expect(cpKey({ cpName: 'Acme s.r.o.', bankType: 'Platba' })).toBe('name:ACME');
    expect(cpKey({ cpAccount: 'garbage', merchant: 'Lidl 12', bankType: 'Platba' })).toBe('name:LIDL');
    expect(cpKey({ bankType: 'Poplatek za tarif' })).toBe('type:POPLATEK ZA TARIF');
  });
});

describe('categorize: layers and priority', () => {
  it('dictionary layer: whole-word, diacritics and case insensitive', () => {
    expect(cat1(tx(-100, { merchant: 'ALBERT HYPERMARKET 12', bankType: 'Platba kartou' }))).toMatchObject({ category: 'groceries', source: 'dictionary' });
    expect(cat1(tx(-100, { cpName: 'Rohlík.cz Finance a.s.' }))).toMatchObject({ category: 'groceries', source: 'dictionary' });
    expect(cat1(tx(-100, { cpName: 'rohlík' })).category).toBe('groceries');
  });

  it('dictionary needs whole words: ALBERTINA is not ALBERT, MOLO is not MOL', () => {
    expect(cat1(tx(-100, { merchant: 'ALBERTINA' })).category).toBe('');
    expect(cat1(tx(-100, { merchant: 'MOLO BAR' })).category).toBe('');
    expect(cat1(tx(-100, { merchant: 'MOL PRAHA' })).category).toBe('transport');
  });

  it('every dictionary keyword is already normalised (upper case ASCII words)', () => {
    for (const [k] of MERCHANT_DICTIONARY) expect(normText(k), k).toBe(k);
  });

  it('card payments also search the message; other payments only the names', () => {
    const card = tx(-100, { bankType: 'Platba kartou', message: 'NETFLIX.COM' });
    expect(cat1(card)).toMatchObject({ category: 'subscriptions', source: 'dictionary' });
    const transfer = tx(-100, { bankType: 'Odchozí úhrada', message: 'NETFLIX.COM' });
    expect(cat1(transfer).category).toBe('');
  });

  it('salary only for incoming payments and only via a message keyword', () => {
    expect(cat1(tx(50000, { bankType: 'Příchozí úhrada', message: 'MZDA 03/2025', cpName: 'ACME' }))).toMatchObject({ category: 'salary', source: 'dictionary' });
    // the word in the counterparty name does not count
    expect(cat1(tx(50000, { cpName: 'MZDA SERVIS', message: 'faktura' })).category).toBe('');
    // an outgoing payment with the keyword is not a salary
    expect(cat1(tx(-50000, { message: 'MZDA' })).category).toBe('');
  });

  it('an incoming card transaction from a merchant (refund) matches the dictionary; other incoming payments skip non-salary keywords', () => {
    expect(cat1(tx(250, { merchant: 'LIDL', bankType: 'Platba kartou' }))).toMatchObject({ category: 'groceries', source: 'dictionary' });
    expect(cat1(tx(250, { merchant: 'LIDL', bankType: 'Vrácení', bankCategory: 'Platba kartou' }))).toMatchObject({ category: 'groceries', source: 'dictionary' });
    expect(cat1(tx(250, { merchant: 'LIDL', bankType: 'Příchozí úhrada' }))).toMatchObject({ category: '', source: 'none' });
    expect(cat1(tx(250, { cpName: 'LIDL', bankType: 'Bezhotovostní příjem' }))).toMatchObject({ category: '', source: 'none' });
  });

  it('bank type layer: interest, interest tax, fees, ATM', () => {
    expect(cat1(tx(12.34, { bankType: 'Připsaný úrok', flow: 'income' }))).toMatchObject({ category: 'interest', source: 'bank' });
    expect(cat1(tx(-1.85, { bankType: 'Daň z úroků' }))).toMatchObject({ category: 'taxes', source: 'bank' });
    expect(cat1(tx(-1.85, { bankType: 'Odvod daně z úroků' }))).toMatchObject({ category: 'taxes', source: 'bank' });
    expect(cat1(tx(-99, { bankType: 'Poplatek za tarif' }))).toMatchObject({ category: 'fees', source: 'bank' });
    expect(cat1(tx(-2000, { bankType: 'Výběr z bankomatu' }))).toMatchObject({ category: 'cash', source: 'bank' });
    expect(cat1(tx(-2000, { bankType: 'Platba', bankCategory: 'Výběr hotovosti' }))).toMatchObject({ category: 'cash', source: 'bank' });
    // outgoing "úrok" is a cost
    expect(cat1(tx(-30, { bankType: 'Úrok z debetu' })).category).toBe('fees');
  });

  it('bank type: "Daň" as a word and "daň z příjmů" are taxes; "Daňový" is not', () => {
    expect(cat1(tx(-1, { bankType: 'Daň' }))).toMatchObject({ category: 'taxes', source: 'bank' });
    expect(cat1(tx(-1, { bankType: 'Daň z příjmů' }))).toMatchObject({ category: 'taxes', source: 'bank' });
    expect(cat1(tx(-1, { bankType: 'Platba', bankCategory: 'Daň' })).category).toBe('taxes');
    expect(cat1(tx(-1, { bankType: 'Daňový doklad' })).category).toBe('');
  });

  it('bank type: cash is only outgoing and "Bezhotovostní" is not cash', () => {
    expect(cat1(tx(-500, { bankType: 'Bezhotovostní platba' })).category).toBe('');
    expect(cat1(tx(500, { bankType: 'Bezhotovostní příjem' })).category).toBe('');
    expect(cat1(tx(-500, { bankType: 'Výdej hotovosti' })).category).toBe('cash');
    expect(cat1(tx(500, { bankType: 'Vklad hotovosti' })).category).toBe('');
    expect(cat1(tx(500, { bankType: 'Výběr z bankomatu' })).category).toBe('');
  });

  it('bank type beats the dictionary; flow beats bank type; rule beats flow; manual beats rule', () => {
    const t = tx(-100, { merchant: 'ALBERT', bankType: 'Poplatek', flow: 'transfer' });
    expect(cat1(t)).toMatchObject({ category: 'transfer', source: 'flow' });
    const e = { ...t, flow: 'expense' as const };
    expect(cat1(e)).toMatchObject({ category: 'fees', source: 'bank' });
    expect(cat1({ ...e, bankType: 'Platba kartou' })).toMatchObject({ category: 'groceries', source: 'dictionary' });
    const r = rule('r1', 'gifts', { name: 'ALBERT' });
    expect(cat1(e, { rules: [r] })).toMatchObject({ category: 'gifts', source: 'rule', ruleId: 'r1' });
    expect(cat1(e, { rules: [r], overrides: { [t.key]: 'health' } })).toMatchObject({ category: 'health', source: 'manual' });
    // a manual assignment can still move a transfer to an expense category
    expect(cat1(t, { overrides: { [t.key]: 'health' } })).toMatchObject({ category: 'health', source: 'manual' });
  });

  it('transfer/investment flow: only rules with a neutral category apply; expense rules do not', () => {
    const t = tx(-100, { cpAccount: '123456/0800', flow: 'transfer' });
    const expenseRule = rule('r1', 'gifts', { cpAccount: '123456/0800' });
    expect(cat1(t, { rules: [expenseRule] })).toMatchObject({ category: 'transfer', source: 'flow' });
    const neutralRule = rule('r2', 'investment', { cpAccount: '123456/0800' });
    expect(cat1(t, { rules: [expenseRule, neutralRule] })).toMatchObject({ category: 'investment', source: 'rule', ruleId: 'r2' });
    // the same rules on an ordinary expense: the first one wins
    expect(cat1({ ...t, flow: 'expense' }, { rules: [expenseRule, neutralRule] })).toMatchObject({ category: 'gifts', ruleId: 'r1' });
  });

  it('investment flow maps to the investment category', () => {
    expect(cat1(tx(-3000, { flow: 'investment' }))).toMatchObject({ category: 'investment', source: 'flow' });
  });

  it('manual "" forces uncategorised even when everything else matches', () => {
    const t = tx(-100, { merchant: 'LIDL' });
    expect(cat1(t, { overrides: { [t.key]: '' } })).toMatchObject({ category: '', source: 'manual' });
  });

  it('an override to an unknown or deleted category is ignored', () => {
    const t = tx(-100, { merchant: 'LIDL' });
    expect(cat1(t, { overrides: { [t.key]: 'nonexistent' } })).toMatchObject({ category: 'groceries', source: 'dictionary' });
    const withoutGroceries = DEFAULT_CATEGORIES.filter((c) => c.id !== 'groceries');
    expect(cat1(t, { categories: withoutGroceries, overrides: { [t.key]: 'groceries' } })).toMatchObject({ category: '', source: 'none' });
  });

  it('a layer that points to a deleted category yields to uncategorised', () => {
    const cats = DEFAULT_CATEGORIES.filter((c) => c.id !== 'groceries' && c.id !== 'transfer');
    expect(cat1(tx(-100, { merchant: 'LIDL' }), { categories: cats })).toMatchObject({ category: '', source: 'none' });
    // deleted 'transfer' category: the transfer is left uncategorised here (summarizeAccounts keeps the flow)
    expect(cat1(tx(-100, { flow: 'transfer' }), { categories: cats }).category).toBe('');
  });

  it('uncategorised result carries a reason', () => {
    expect(cat1(tx(-100, { cpName: 'UNKNOWN PERSON' }))).toMatchObject({ category: '', source: 'none', reason: 'nezařazeno' });
  });
});

describe('rules', () => {
  const t = (extra: Partial<T> = {}) => tx(-100, { merchant: 'ALBERT HYPERMARKET 12', cpAccount: '0000123456/0800', ...extra });

  it('cpAccount is normalised on both sides (leading zeros, prefix)', () => {
    expect(ruleMatches({ cpAccount: '123456/0800' }, t())).toBe(true);
    expect(ruleMatches({ cpAccount: '123456/0800' }, t({ cpAccount: '000000-0123456/0800' }))).toBe(true);
    expect(ruleMatches({ cpAccount: '19-123456/0800' }, t({ cpAccount: '0019-0123456/0800' }))).toBe(true);
    expect(ruleMatches({ cpAccount: '19-123456/0800' }, t())).toBe(false);
    expect(ruleMatches({ cpAccount: '123456/0800' }, t({ cpAccount: undefined }))).toBe(false);
  });

  it('name is matched exactly against the normalised name (no prefix)', () => {
    const n = (extra: Partial<T> = {}) => t({ cpAccount: undefined, ...extra });
    expect(ruleMatches({ name: 'ALBERT HYPERMARKET' }, n())).toBe(true);
    expect(ruleMatches({ name: 'ALBERT' }, n())).toBe(false);
    expect(ruleMatches({ name: 'ALBERT' }, n({ merchant: 'ALBERTINA' }))).toBe(false);
    expect(ruleMatches({ name: 'HYPERMARKET' }, n())).toBe(false);
  });

  it('a rule with a name but no cpAccount does not match transactions that have a counterparty account', () => {
    expect(ruleMatches({ name: 'ALBERT HYPERMARKET' }, t())).toBe(false);
    expect(ruleMatches({ name: 'ALBERT HYPERMARKET', cpAccount: '123456/0800' }, t())).toBe(true);
    expect(ruleMatches({ name: 'OTHER', cpAccount: '123456/0800' }, t())).toBe(false);
  });

  it('text matches whole words in merchant, counterparty, message or note', () => {
    expect(ruleMatches({ text: 'FAKTURA 2025' }, t({ message: 'Faktura 2025' }))).toBe(true);
    expect(ruleMatches({ text: 'POZNAMKA' }, t({ note: 'moje poznámka' }))).toBe(true);
    expect(ruleMatches({ text: 'FAKT' }, t({ message: 'Faktura' }))).toBe(false);
    expect(ruleMatches({ text: 'HYPERMARKET' }, t())).toBe(true);
  });

  it('direction and accountId restrict the rule', () => {
    const A = '123456/0800';
    expect(ruleMatches({ cpAccount: A, direction: 'out' }, t())).toBe(true);
    expect(ruleMatches({ cpAccount: A, direction: 'in' }, t())).toBe(false);
    expect(ruleMatches({ cpAccount: A, direction: 'in' }, t({ amount: 100 }))).toBe(true);
    expect(ruleMatches({ cpAccount: A, direction: 'out' }, t({ amount: 100 }))).toBe(false);
    expect(ruleMatches({ cpAccount: A, accountId: KB }, t())).toBe(true);
    expect(ruleMatches({ cpAccount: A, accountId: '222222/5500' }, t())).toBe(false);
  });

  it('a rule without a counterparty condition never matches', () => {
    expect(ruleMatches({}, t())).toBe(false);
    expect(ruleMatches({ direction: 'out' }, t())).toBe(false);
    expect(ruleMatches({ accountId: KB, direction: 'out' }, t())).toBe(false);
  });

  it('the first matching rule wins', () => {
    const x = t();
    const A = '123456/0800';
    const rules = [rule('a', 'gifts', { cpAccount: '1/0800' }), rule('b', 'health', { cpAccount: A }), rule('c', 'travel', { cpAccount: A })];
    expect(cat1(x, { rules })).toMatchObject({ category: 'health', ruleId: 'b', source: 'rule' });
  });

  it('a rule pointing to a deleted category is ignored (the next rule applies)', () => {
    const x = t();
    const rules = [rule('a', 'ghost', { cpAccount: '123456/0800' }), rule('b', 'travel', { cpAccount: '123456/0800' })];
    expect(cat1(x, { rules })).toMatchObject({ category: 'travel', ruleId: 'b' });
    expect(cat1(x, { rules: [rules[0]] })).toMatchObject({ category: 'groceries', source: 'dictionary' });
  });

  it('describeRule and ruleForGroup', () => {
    expect(describeRule({ cpAccount: '1/0100', direction: 'out' })).toContain('protiúčet 1/0100');
    expect(describeRule({ name: 'X', text: 'Y', accountId: KB, direction: 'in' })).toMatch(/„X“.*„Y“.*jen příchozí.*jen účet/);
    expect(ruleForGroup(t(), 'gifts', 'r1')).toEqual({ id: 'r1', category: 'gifts', match: { cpAccount: '123456/0800', direction: 'out' } });
    expect(ruleForGroup(t({ cpAccount: undefined }), 'gifts', 'r1')).toEqual({ id: 'r1', category: 'gifts', match: { name: 'ALBERT HYPERMARKET', direction: 'out' } });
    expect(ruleForGroup({ amount: -5, bankType: 'Poplatek' }, 'fees', 'r2')).toBeNull();
  });
});

describe('learned layer', () => {
  const unknown = (amount: number, i: number) => tx(amount, { cpName: 'NEW SHOP ' + i, cpAccount: '777/0800' });

  it('majority vote of manual overrides of the same direction and counterparty', () => {
    const a = unknown(-10, 1);
    const b = unknown(-20, 2);
    const c = unknown(-30, 3);
    const target = unknown(-40, 4);
    const overrides = { [a.key]: 'gifts', [b.key]: 'gifts', [c.key]: 'health' };
    const r = categorize([a, b, c, target], ctx({ overrides })).get(target.key)!;
    expect(r).toMatchObject({ category: 'gifts', source: 'learned' });
    expect(r.reason).toContain('Dárky');
  });

  it('is separated by direction', () => {
    const out = unknown(-10, 1);
    const inc = unknown(10, 2);
    const r = categorize([out, inc], ctx({ overrides: { [out.key]: 'gifts' } }));
    expect(r.get(inc.key)).toMatchObject({ category: '', source: 'none' });
  });

  it('ties are broken by category id; learned never overrides other layers', () => {
    const a = unknown(-10, 1);
    const b = unknown(-10, 2);
    const target = unknown(-10, 3);
    expect(categorize([a, b, target], ctx({ overrides: { [a.key]: 'health', [b.key]: 'gifts' } })).get(target.key)!.category).toBe('gifts');
    const known = { ...unknown(-10, 4), bankType: 'Poplatek' };
    expect(categorize([a, known], ctx({ overrides: { [a.key]: 'health' } })).get(known.key)).toMatchObject({ category: 'fees', source: 'bank' });
  });

  it('counterparties without identity (type: keys) are not learned', () => {
    const a = tx(-10, { bankType: 'Poplatek za tarif' });
    const b = tx(-10, { bankType: 'Poplatek za tarif' });
    expect(cpKey(a)).toMatch(/^type:/);
    const r = categorize([a, b], ctx({ overrides: { [a.key]: 'health' } }));
    expect(r.get(b.key)).toMatchObject({ category: 'fees', source: 'bank' });
    const c = tx(-10, { bankType: 'Neznámý typ' });
    const d = tx(-10, { bankType: 'Neznámý typ' });
    expect(categorize([c, d], ctx({ overrides: { [c.key]: 'health' } })).get(d.key)!.source).toBe('none');
  });

  it('learned suggestions never apply to transfer/investment flow', () => {
    const a = unknown(-10, 1);
    const target = { ...unknown(-10, 1), flow: 'transfer' as const };
    const r = categorize([a, target], ctx({ overrides: { [a.key]: 'gifts' } })).get(target.key)!;
    expect(r).toMatchObject({ category: 'transfer', source: 'flow' });
    const inv = { ...unknown(-10, 1), flow: 'investment' as const };
    expect(categorize([a, inv], ctx({ overrides: { [a.key]: 'gifts' } })).get(inv.key)!.source).toBe('flow');
  });

  it('manual "" (uncategorised) does not vote', () => {
    const a = unknown(-10, 1);
    const target = unknown(-10, 2);
    expect(categorize([a, target], ctx({ overrides: { [a.key]: '' } })).get(target.key)!.source).toBe('none');
  });
});

describe('sanitizers', () => {
  it('sanitizeCategories: non-array -> undefined; drops bad ids, duplicates, empty names; trims and defaults kind', () => {
    expect(sanitizeCategories(undefined)).toBeUndefined();
    expect(sanitizeCategories({})).toBeUndefined();
    const out = sanitizeCategories([
      { id: 'ok', name: '  Fine  ', kind: 'income' },
      { id: 'ok', name: 'dup', kind: 'income' },
      { id: 'Bad Id', name: 'x' },
      { id: '', name: 'x' },
      { id: 'a'.repeat(41), name: 'x' },
      { id: 'noname', name: '   ' },
      { id: 'weird-kind', name: 'W', kind: 'bogus' },
      { id: 'neutral', name: 'N', kind: 'neutral' },
      { id: 5, name: 'num' },
      null,
      'str',
    ]);
    expect(out).toEqual([
      { id: 'ok', name: 'Fine', kind: 'income' },
      { id: 'weird-kind', name: 'W', kind: 'expense' },
      { id: 'neutral', name: 'N', kind: 'neutral' },
      ...LOCKED_DEFAULTS,
    ]);
  });

  it('transfer and investment are always present and always neutral', () => {
    expect(sanitizeCategories([])).toEqual(LOCKED_DEFAULTS);
    const out = sanitizeCategories([
      { id: 'transfer', name: 'Moje převody', kind: 'expense' },
      { id: 'investment', name: 'Inv', kind: 'income' },
      { id: 'x', name: 'X', kind: 'expense' },
    ]);
    expect(out).toEqual([
      { id: 'transfer', name: 'Moje převody', kind: 'neutral' },
      { id: 'investment', name: 'Inv', kind: 'neutral' },
      { id: 'x', name: 'X', kind: 'expense' },
    ]);
    // a missing one is appended
    expect(sanitizeCategories([{ id: 'x', name: 'X' }, { id: 'transfer', name: 'T', kind: 'neutral' }])!.map((c) => c.id)).toEqual(['x', 'transfer', 'investment']);
    expect([...LOCKED].sort()).toEqual(['investment', 'transfer']);
  });

  it('sanitizeCategories caps names at 60 chars and the list at 200', () => {
    expect(sanitizeCategories([{ id: 'a', name: 'x'.repeat(100) }])![0].name).toHaveLength(60);
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, name: `C${i}` }));
    expect(sanitizeCategories(many)).toHaveLength(202); // 200 + the two locked ones
  });

  it('sanitizeRules: validates ids, categories and conditions; normalises the match', () => {
    const ids = new Set(['gifts']);
    const out = sanitizeRules(
      [
        { id: 'r1', category: 'gifts', match: { cpAccount: '0000123/0800', name: 'Rohlík s.r.o.', text: ' Faktura ', direction: 'out', accountId: '111111/0100' } },
        { id: 'r2', category: 'gifts', match: { direction: 'in' } }, // no counterparty condition
        { id: 'r3', category: 'missing', match: { name: 'X' } },
        { id: 'BAD ID', category: 'gifts', match: { name: 'X' } },
        { id: 'r5', category: 'gifts', match: { cpAccount: 'junk' } }, // normalises to nothing
        { id: 'r6', category: 'gifts' },
        { id: 'r7', category: 'gifts', match: { name: 'X', direction: 'sideways', accountId: 'bad' } },
        null,
      ],
      ids,
    );
    expect(out).toEqual([
      { id: 'r1', category: 'gifts', match: { cpAccount: '123/0800', name: 'ROHLIK S R O', text: 'FAKTURA', direction: 'out', accountId: '111111/0100' } },
      { id: 'r7', category: 'gifts', match: { name: 'X' } },
    ]);
    expect(sanitizeRules('nope', ids)).toEqual([]);
  });

  it('sanitizeRules caps at MAX_RULES and drops duplicate ids', () => {
    const rules = Array.from({ length: MAX_RULES + 500 }, (_, i) => ({ id: `r${i}`, category: 'gifts', match: { name: 'X' } }));
    expect(MAX_RULES).toBe(2000);
    expect(sanitizeRules(rules, new Set(['gifts']))).toHaveLength(MAX_RULES);
    const dup = sanitizeRules([{ id: 'a', category: 'gifts', match: { name: 'X' } }, { id: 'a', category: 'health', match: { name: 'Y' } }], new Set(['gifts', 'health']));
    expect(dup).toEqual([{ id: 'a', category: 'gifts', match: { name: 'X' } }]);
  });

  it('ruleSignature identifies equal conditions; prepareTx normalises a transaction', () => {
    expect(ruleSignature({ name: 'X', direction: 'out' })).toBe(ruleSignature({ direction: 'out', name: 'X' }));
    expect(ruleSignature({ name: 'X', direction: 'out' })).not.toBe(ruleSignature({ name: 'X', direction: 'in' }));
    expect(ruleSignature({ name: 'X' })).not.toBe(ruleSignature({ text: 'X' }));
    expect(prepareTx(tx(-1, { cpAccount: '000123/0800', merchant: 'Lidl 5', message: 'Nákup' }))).toEqual({ account: '123/0800', name: 'LIDL', hay: ' LIDL 5 NAKUP ' });
  });

  it('sanitizeOverrides: only FIO:/KB:/RB: keys, known categories or "", no prototype pollution', () => {
    const ids = new Set(['gifts']);
    const raw = JSON.parse('{"KB:1/0100:1":"gifts","FIO:x":"","RB:y":"ghost","XTB:z":"gifts","__proto__":"gifts","constructor":"gifts","KB:num":5}');
    const out = sanitizeOverrides(raw, ids);
    expect(out).toEqual({ 'KB:1/0100:1': 'gifts', 'FIO:x': '' });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).gifts).toBeUndefined();
    expect(sanitizeOverrides([], ids)).toEqual({});
    expect(sanitizeOverrides(null, ids)).toEqual({});
    expect(sanitizeOverrides({ ['KB:' + 'x'.repeat(250)]: 'gifts' }, ids)).toEqual({});
  });

  it('default categories are internally consistent', () => {
    const ids = DEFAULT_CATEGORIES.map((c: Category) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sanitizeCategories(DEFAULT_CATEGORIES)).toEqual(DEFAULT_CATEGORIES);
    for (const [, cat] of MERCHANT_DICTIONARY) expect(ids).toContain(cat);
  });
});

describe('default income categories', () => {
  it('include business income and gifts received', () => {
    const income = DEFAULT_CATEGORIES.filter((c) => c.kind === 'income').map((c) => [c.id, c.name]);
    expect(income).toEqual([
      ['salary', 'Mzda'],
      ['business', 'Podnikatelská činnost'],
      ['gifts-received', 'Dary'],
      ['interest', 'Úroky'],
      ['other-income', 'Ostatní příjmy'],
    ]);
  });
});
