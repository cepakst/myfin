import { describe, expect, it } from 'vitest';
import { defaultAccountsConfig, sanitizeAccountsConfig, summarizeAccounts, type AccountsConfig } from '../src/core/accounts/analytics.js';
import { DEFAULT_CATEGORIES } from '../src/core/accounts/categories.js';
import { emptyBankLedger, type BankAccountData, type BankLedger, type BankTx } from '../src/core/accounts/types.js';

const KB = '111111/0100';
const RB = '222222/5500';
const TODAY = '2025-06-15';
const conv = (amount: number, currency: string) => (currency === 'EUR' ? amount * 25 : null);
const cfg = (extra: Partial<AccountsConfig> = {}): AccountsConfig => ({ ...defaultAccountsConfig(), ...extra });

let seq = 0;
function tx(accountId: string, date: string, amount: number, extra: Partial<BankTx> = {}): BankTx {
  const bank = accountId.endsWith('/5500') ? 'RB' : 'KB';
  seq++;
  return { key: `${bank}:${accountId}:c${seq}`, bank, accountId, date, amount, currency: 'CZK', bankType: '', ...extra };
}
function ledgerOf(accounts: Partial<BankAccountData>[], txs: BankTx[]): BankLedger {
  const l = emptyBankLedger();
  for (const a of accounts) {
    const id = a.id!;
    l.accounts.set(id, { id, bank: a.bank ?? 'KB', number: id.split('/')[0], currency: 'CZK', balancePoints: [], ...a });
  }
  l.txs = txs;
  return l;
}

function sample() {
  const salary = tx(KB, '2025-05-10', 50000, { cpAccount: '2700112233/2010', cpName: 'ACME', message: 'MZDA' });
  const toRb = tx(KB, '2025-05-12', -10000, { cpAccount: RB });
  const fromKb = tx(RB, '2025-05-12', 10000, { cpAccount: KB });
  const rent = tx(KB, '2025-06-01', -5000, { cpAccount: '35-4400220033/0100', cpName: 'Landlord' });
  const wolt = tx(RB, '2025-06-03', -300, { merchant: 'WOLT', bankType: 'Platba kartou' });
  const mystery = tx(RB, '2025-06-04', -700, { cpName: 'SOMEONE', cpAccount: '999/0800' });
  const l = ledgerOf(
    [
      { id: KB, bank: 'KB' },
      { id: RB, bank: 'RB' },
    ],
    [salary, toRb, fromKb, rent, wolt, mystery],
  );
  return { salary, toRb, fromKb, rent, wolt, mystery, l };
}
const view = (s: ReturnType<typeof summarizeAccounts>, key: string) => s.txs.find((t) => t.key === key)!;

describe('summarizeAccounts: categories', () => {
  it('adds category, source, reason, cpKey and cpLabel to every transaction and returns the categories', () => {
    const { l, salary, wolt, mystery, rent } = sample();
    const s = summarizeAccounts(l, cfg(), TODAY, conv);
    expect(s.categories.map((c) => c.id)).toContain('groceries');
    expect(view(s, salary.key)).toMatchObject({ category: 'salary', categorySource: 'dictionary', flow: 'income', cpKey: 'acc:2700112233/2010', cpLabel: 'ACME' });
    expect(view(s, wolt.key)).toMatchObject({ category: 'eating-out', flow: 'expense', cpKey: 'name:WOLT' });
    expect(view(s, mystery.key)).toMatchObject({ category: '', categorySource: 'none', flow: 'expense', cpLabel: 'SOMEONE' });
    expect(view(s, rent.key).category).toBe('');
  });

  it('categorisation numbers: totals, categorised share, uncategorised count', () => {
    const { l } = sample();
    const s = summarizeAccounts(l, cfg(), TODAY, conv);
    // expenses: rent 5000 (uncategorised), wolt 300, mystery 700 (uncategorised); transfers excluded
    expect(s.categorization).toEqual({ expenseTotalCzk: 6000, expenseCategorizedCzk: 300, uncategorized: 2, suggestions: 0 });
  });

  it('a manual assignment counts as categorised', () => {
    const { l, mystery } = sample();
    const s = summarizeAccounts(l, cfg({ overrides: { [mystery.key]: 'gifts' } }), TODAY, conv);
    expect(s.categorization).toEqual({ expenseTotalCzk: 6000, expenseCategorizedCzk: 1000, uncategorized: 1, suggestions: 0 });
  });

  it('a learned suggestion is shown but is not counted as categorised', () => {
    const { l, mystery } = sample();
    const sib = tx(RB, '2025-06-05', -50, { cpName: 'SOMEONE', cpAccount: '999/0800' });
    l.txs.push(sib);
    const s = summarizeAccounts(l, cfg({ overrides: { [mystery.key]: 'gifts' } }), TODAY, conv);
    expect(view(s, sib.key)).toMatchObject({ category: 'gifts', categorySource: 'learned', flow: 'expense' });
    expect(s.categorization.suggestions).toBe(1);
    expect(s.categorization.expenseTotalCzk).toBe(6050);
    expect(s.categorization.expenseCategorizedCzk).toBe(1000); // wolt 300 + mystery 700, not the suggestion
    expect(s.categorization.uncategorized).toBe(1); // only the rent
  });

  it('a user moves an internal transfer to an expense category -> it counts as an expense', () => {
    const { l, toRb, fromKb } = sample();
    const base = summarizeAccounts(l, cfg(), TODAY, conv);
    expect(base.months.find((m) => m.month === '2025-05')).toMatchObject({ income: 50000, expense: 0 });
    const s = summarizeAccounts(l, cfg({ overrides: { [toRb.key]: 'gifts' } }), TODAY, conv);
    expect(view(s, toRb.key)).toMatchObject({ category: 'gifts', categorySource: 'manual', flow: 'expense' });
    expect(view(s, fromKb.key).flow).toBe('transfer');
    expect(s.months.find((m) => m.month === '2025-05')!.expense).toBe(10000);
    expect(s.totals.expense12m).toBe(base.totals.expense12m + 10000);
  });

  it('an expense moved to a neutral category leaves the income/expense statistics', () => {
    const { l, rent } = sample();
    const base = summarizeAccounts(l, cfg(), TODAY, conv);
    const s = summarizeAccounts(l, cfg({ overrides: { [rent.key]: 'transfer' } }), TODAY, conv);
    expect(view(s, rent.key)).toMatchObject({ category: 'transfer', flow: 'transfer' });
    expect(s.totals.expense12m).toBe(base.totals.expense12m - 5000);
    const s2 = summarizeAccounts(l, cfg({ overrides: { [rent.key]: 'investment' } }), TODAY, conv);
    expect(view(s2, rent.key).flow).toBe('investment');
    expect(s2.totals.invested12m).toBe(base.totals.invested12m + 5000);
  });

  it('the kind of the category decides the flow: an income category on an outgoing payment', () => {
    const { l, rent } = sample();
    const categories = [...DEFAULT_CATEGORIES, { id: 'refund', name: 'Vratka', kind: 'income' as const }];
    const s = summarizeAccounts(l, cfg({ categories, overrides: { [rent.key]: 'refund' } }), TODAY, conv);
    expect(view(s, rent.key).flow).toBe('income');
  });

  it('deleting the transfer category keeps transfers as transfers (uncategorised keeps the original flow)', () => {
    const { l, toRb } = sample();
    const categories = DEFAULT_CATEGORIES.filter((c) => c.id !== 'transfer');
    const s = summarizeAccounts(l, cfg({ categories }), TODAY, conv);
    expect(view(s, toRb.key)).toMatchObject({ category: '', flow: 'transfer' });
    expect(s.months.find((m) => m.month === '2025-05')!.expense).toBe(0);
    // uncategorised transfers are not part of the spending share
    expect(s.categorization.expenseTotalCzk).toBe(6000);
  });

  it('a rule is applied and reported with its id; a rule for a deleted category is ignored', () => {
    const { l, mystery } = sample();
    const rules = [{ id: 'r1', category: 'gifts', match: { cpAccount: '999/0800', direction: 'out' as const } }];
    const s = summarizeAccounts(l, cfg({ rules }), TODAY, conv);
    expect(view(s, mystery.key)).toMatchObject({ category: 'gifts', categorySource: 'rule', ruleId: 'r1' });
    const s2 = summarizeAccounts(l, cfg({ rules: [{ ...rules[0], category: 'ghost' }] }), TODAY, conv);
    expect(view(s2, mystery.key).category).toBe('');
  });

  it('hidden accounts are excluded from the categorisation numbers', () => {
    const { l } = sample();
    const s = summarizeAccounts(l, cfg({ accounts: { [RB]: { hidden: true } } }), TODAY, conv);
    // only the KB rent (5000, uncategorised) remains visible
    expect(s.categorization).toEqual({ expenseTotalCzk: 5000, expenseCategorizedCzk: 0, uncategorized: 1, suggestions: 0 });
  });

  it('converts foreign currency amounts for the shares', () => {
    const e = tx(KB, '2025-06-02', -10, { currency: 'EUR', merchant: 'LIDL' });
    const l = ledgerOf([{ id: KB, bank: 'KB' }], [e]);
    const s = summarizeAccounts(l, cfg(), TODAY, conv);
    expect(s.categorization).toEqual({ expenseTotalCzk: 250, expenseCategorizedCzk: 250, uncategorized: 0, suggestions: 0 });
  });
});

describe('sanitizeAccountsConfig: categories, rules, overrides', () => {
  const base = { version: 1, accounts: {}, ownAccounts: [] };

  it('defaults: no categories (the built-in set is used), empty rules and overrides', () => {
    const c = sanitizeAccountsConfig(base);
    expect(c.categories).toBeUndefined();
    expect(c.rules).toEqual([]);
    expect(c.overrides).toEqual({});
    expect(defaultAccountsConfig()).toMatchObject({ rules: [], overrides: {} });
  });

  it('round-trips valid categories, rules and overrides', () => {
    const raw = {
      ...base,
      categories: [
        { id: 'mine', name: 'Moje', kind: 'expense' },
        { id: 'transfer', name: 'Převod', kind: 'neutral' },
        { id: 'investment', name: 'Investice', kind: 'neutral' },
      ],
      rules: [{ id: 'r1', category: 'mine', match: { name: 'X', direction: 'out' } }],
      overrides: { 'KB:1/0100:5': 'mine', 'FIO:abc': '' },
    };
    const c = sanitizeAccountsConfig(raw);
    expect(c).toMatchObject(raw);
    expect(sanitizeAccountsConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it('validates rules and overrides against the user categories, not the defaults', () => {
    const c = sanitizeAccountsConfig({
      ...base,
      categories: [{ id: 'mine', name: 'Moje', kind: 'expense' }],
      rules: [
        { id: 'r1', category: 'groceries', match: { name: 'X' } },
        { id: 'r2', category: 'mine', match: { name: 'X' } },
      ],
      overrides: { 'KB:a': 'groceries', 'KB:b': 'mine' },
    });
    expect(c.rules.map((r) => r.id)).toEqual(['r2']);
    expect(c.overrides).toEqual({ 'KB:b': 'mine' });
  });

  it('an empty user category list leaves only the locked categories and nothing validates against the defaults', () => {
    const c = sanitizeAccountsConfig({ ...base, categories: [], rules: [{ id: 'r', category: 'groceries', match: { name: 'X' } }], overrides: { 'KB:a': 'groceries' } });
    expect(c.categories!.map((x) => x.id)).toEqual(['transfer', 'investment']);
    expect(c.rules).toEqual([]);
    expect(c.overrides).toEqual({});
  });

  it('drops bad shapes without throwing', () => {
    const c = sanitizeAccountsConfig({ ...base, categories: 'x', rules: 'x', overrides: [] });
    expect(c.categories).toBeUndefined();
    expect(c.rules).toEqual([]);
    expect(c.overrides).toEqual({});
  });
});
