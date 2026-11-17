import { describe, expect, it } from 'vitest';
import {
  balanceSeries,
  classifyFlows,
  defaultAccountsConfig,
  inferProduct,
  monthEnd,
  monthsBetween,
  normAccount,
  sanitizeAccountsConfig,
  summarizeAccounts,
  uniqueNames,
  type AccountsConfig,
  type AccountView,
} from '../src/core/accounts/analytics.js';
import { buildBankLedger } from '../src/core/accounts/ledger.js';
import { BANK_CODE, defaultAccountName, emptyBankLedger, type Bank, type BankAccountData, type BankLedger, type BankTx } from '../src/core/accounts/types.js';
import { fioCsv } from './bankFixtures.js';

let seq = 0;
function tx(accountId: string, date: string, amount: number, extra: Partial<BankTx> = {}): BankTx {
  const bank = (Object.entries(BANK_CODE).find(([, c]) => accountId.endsWith(`/${c}`))?.[0] ?? 'KB') as Bank;
  seq++;
  return { key: `${bank}:${accountId}:${seq}`, bank, accountId, date, amount, currency: 'CZK', bankType: '', ...extra };
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

describe('normAccount', () => {
  it('strips leading zeros of prefix and number and the whitespace', () => {
    expect(normAccount('000019-0002000145/0100')).toBe('19-2000145/0100');
    expect(normAccount(' 19 - 2000145398 / 0100 ')).toBe('19-2000145398/0100');
    expect(normAccount('0000123456/0800')).toBe('123456/0800');
    expect(normAccount('2101234567/2010')).toBe('2101234567/2010');
    expect(normAccount('000000-2101234567/2010')).toBe('2101234567/2010');
  });

  it('returns undefined for anything that is not a Czech account number', () => {
    expect(normAccount(undefined)).toBeUndefined();
    expect(normAccount('')).toBeUndefined();
    expect(normAccount('123456')).toBeUndefined();
    expect(normAccount('CZ6501000000192000145398')).toBeUndefined();
    expect(normAccount('abc/0100')).toBeUndefined();
  });
});

describe('classifyFlows', () => {
  const KB = '111111/0100';
  const RB = '222222/5500';
  const kbOut = (extra: Partial<BankTx>) => tx(KB, '2025-05-10', -100, extra);
  const flow = (t: BankTx, own: Parameters<typeof classifyFlows>[2] = [], accounts: string[] = [KB, RB]) => classifyFlows([t], accounts, own).get(t.key)!;

  it('a payment to another own (imported) account is a transfer, in both directions', () => {
    const out = kbOut({ cpAccount: '0000222222/5500' });
    expect(flow(out)).toEqual({ flow: 'transfer', otherAccount: RB });
    const inc = tx(RB, '2025-05-10', 100, { cpAccount: '111111/0100' });
    expect(flow(inc)).toEqual({ flow: 'transfer', otherAccount: KB });
  });

  it('a payment to the same account is not a transfer', () => {
    expect(flow(kbOut({ cpAccount: KB })).flow).toBe('expense');
  });

  it('a configured own account (other bank) is a transfer; kind "investment" is an investment', () => {
    const t = kbOut({ cpAccount: '5555555/0800' });
    expect(flow(t).flow).toBe('expense');
    expect(flow(t, [{ account: '5555555/0800', kind: 'own' }])).toEqual({ flow: 'transfer', otherAccount: '5555555/0800' });
    expect(flow(t, [{ account: '5555555/0800', kind: 'investment' }])).toEqual({ flow: 'investment', otherAccount: '5555555/0800' });
    // the configured kind beats the "imported account" default
    expect(flow(kbOut({ cpAccount: RB }), [{ account: RB, kind: 'investment' }]).flow).toBe('investment');
  });

  it('a broker named as counterparty is an investment', () => {
    expect(flow(kbOut({ cpAccount: '1000123456/5800', cpName: 'DEGIRO' })).flow).toBe('investment');
    expect(flow(kbOut({ cpAccount: '2501234567/2010', cpName: 'XTB S.A., organizační složka' })).flow).toBe('investment');
    expect(flow(kbOut({ bankType: 'Odchozí úhrada', cpName: 'Interactive Brokers' })).flow).toBe('investment');
    // without a counterparty account the movement type must look like a payment
    expect(flow(kbOut({ bankType: 'Poplatek', cpName: 'XTB' })).flow).toBe('expense');
  });

  // the real counterparty name of Degiro deposits is "flatexDEGIRO Bank AG" (no word boundary before DEGIRO)
  // BUG (src/core/accounts/analytics.ts BROKER_NAME): (degiro|flatex) does not match "flatexDEGIRO"
  it('flatexDEGIRO Bank AG is recognised as a broker', () => {
    expect(flow(kbOut({ cpAccount: '1000123456/5800', cpName: 'flatexDEGIRO Bank AG' })).flow).toBe('investment');
  });

  it('RB "Inteligentní spoření" and other internal transfer types are transfers without a counterparty', () => {
    expect(flow(kbOut({ bankType: 'Inteligentní spoření - převod prostředků na spořicí účet' })).flow).toBe('transfer');
    expect(flow(kbOut({ bankType: 'Převod prostředků ze spořicí účtu' })).flow).toBe('expense'); // typo "spořicí účtu" is not the bank text
    expect(flow(kbOut({ bankType: 'Převod prostředků ze spořicí účet' })).flow).toBe('transfer');
    expect(flow(kbOut({ bankType: 'Převod mezi vlastními účty' })).flow).toBe('transfer');
  });

  it('everything else is income or expense by sign', () => {
    expect(flow(tx(KB, '2025-05-10', 1000, { cpAccount: '999/0300' })).flow).toBe('income');
    expect(flow(tx(KB, '2025-05-10', 0)).flow).toBe('income');
    expect(flow(tx(KB, '2025-05-10', -1)).flow).toBe('expense');
  });
});

describe('inferProduct', () => {
  const t = (type: string) => tx('1/0100', '2025-01-01', 1, { bankType: type });
  it('uses the account name first', () => {
    expect(inferProduct({ name: 'Spořicí účet' }, [])).toBe('savings');
    expect(inferProduct({ name: 'Zlatý spořicí' }, [])).toBe('savings');
    expect(inferProduct({ name: 'Termínovaný vklad' }, [])).toBe('term');
    expect(inferProduct({ name: 'Kreditní karta' }, [])).toBe('credit');
    expect(inferProduct({ name: 'eKonto SMART' }, [])).toBe('current');
    expect(inferProduct({ name: 'Běžný účet se spořením' }, [])).toBe('current');
  });
  it('without a name: no movements = current; mostly interest and no card payments = savings', () => {
    expect(inferProduct({}, [])).toBe('current');
    expect(inferProduct({}, [t('Kladný úrok'), t('Daň z úroků'), t('Převod')])).toBe('savings');
    expect(inferProduct({}, [t('Kladný úrok'), t('Daň z úroků'), t('Platba kartou')])).toBe('current');
    expect(inferProduct({}, [t('Kladný úrok'), t('Převod'), t('Převod'), t('Převod'), t('Převod')])).toBe('current'); // only one interest row
    expect(inferProduct({}, [t('Kladný úrok'), t('Odvod daně'), ...Array.from({ length: 20 }, () => t('Převod'))])).toBe('current'); // interest share below 20 %
  });
});

describe('balanceSeries', () => {
  const A = '1/0100';
  const txs = [tx(A, '2025-01-05', 100), tx(A, '2025-01-05', 0.1), tx(A, '2025-01-10', -30.1)];

  it('without anchors the balance is the sum of movements from zero', () => {
    const s = balanceSeries(txs, []);
    expect(s.anchored).toBe(false);
    expect(s.at('2025-01-04')).toBe(0);
    expect(s.at('2025-01-05')).toBe(100.1);
    expect(s.at('2025-01-31')).toBe(70);
    expect(s.mismatches).toEqual([]);
  });

  it('an anchor before the movements gives end-of-day balances', () => {
    const s = balanceSeries(txs, [{ date: '2025-01-01', balance: 1000 }]);
    expect(s.anchored).toBe(true);
    expect(s.at('2024-12-01')).toBe(1000); // before the anchor: movements between are subtracted (none)
    expect(s.at('2025-01-04')).toBe(1000);
    expect(s.at('2025-01-05')).toBe(1100.1);
    expect(s.at('2025-01-31')).toBe(1070);
  });

  it('an anchor after the movements counts backwards', () => {
    const s = balanceSeries(txs, [{ date: '2025-01-10', balance: 1070 }]);
    expect(s.at('2025-01-10')).toBe(1070);
    expect(s.at('2025-01-05')).toBe(1100.1);
    expect(s.at('2025-01-04')).toBe(1000);
    expect(s.at('2025-01-31')).toBe(1070);
  });

  it('an anchor on a movement day is the end-of-day balance', () => {
    const s = balanceSeries(txs, [{ date: '2025-01-05', balance: 500 }]);
    expect(s.at('2025-01-05')).toBe(500);
    expect(s.at('2025-01-04')).toBe(399.9);
    expect(s.at('2025-01-10')).toBe(469.9);
  });

  it('consistent anchors have no mismatch; a missing statement is reported with its period and difference', () => {
    expect(balanceSeries(txs, [{ date: '2025-01-01', balance: 1000 }, { date: '2025-01-31', balance: 1070 }]).mismatches).toEqual([]);
    const s = balanceSeries(txs, [{ date: '2025-01-01', balance: 1000 }, { date: '2025-01-31', balance: 1100 }]);
    expect(s.mismatches).toEqual([{ from: '2025-01-02', to: '2025-01-31', difference: 30 }]);
    // each date uses the nearest preceding anchor
    expect(s.at('2025-01-31')).toBe(1100);
    expect(s.at('2025-01-09')).toBe(1100.1);
  });

  it('anchors are used in date order regardless of the input order', () => {
    const s = balanceSeries(txs, [{ date: '2025-01-31', balance: 1070 }, { date: '2025-01-01', balance: 1000 }]);
    expect(s.mismatches).toEqual([]);
  });
});

describe('months', () => {
  it('monthsBetween spans year ends and monthEnd handles leap years', () => {
    expect(monthsBetween('2024-11-15', '2025-02-01')).toEqual(['2024-11', '2024-12', '2025-01', '2025-02']);
    expect(monthsBetween('2025-03-01', '2025-03-31')).toEqual(['2025-03']);
    expect(monthsBetween('2025-04-01', '2025-03-31')).toEqual([]);
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(monthEnd('2025-02')).toBe('2025-02-28');
    expect(monthEnd('2025-12')).toBe('2025-12-31');
  });
});

describe('summarizeAccounts', () => {
  const KB = '111111/0100';
  const RB = '222222/5500';
  const FIO = '333333/2010';
  const TODAY = '2025-06-15';
  const eur = (amount: number, currency: string) => (currency === 'EUR' ? amount * 25 : null);

  function sample(): BankLedger {
    return ledgerOf(
      [
        { id: KB, bank: 'KB', balancePoints: [{ date: '2025-04-30', balance: 1000 }] },
        { id: RB, bank: 'RB', name: 'eKonto SMART' },
        { id: FIO, bank: 'FIO', currency: 'EUR', balancePoints: [{ date: '2025-05-31', balance: 500 }] },
      ],
      [
        tx(KB, '2025-05-10', 50000, { cpAccount: '2700112233/2010', cpName: 'ACME' }),
        tx(KB, '2025-05-12', -10000, { cpAccount: RB }),
        tx(KB, '2025-05-20', -2000, { cpAccount: '1000123456/5800', cpName: 'DEGIRO Bank' }),
        tx(KB, '2025-06-01', -5000, { cpAccount: '35-4400220033/0100', cpName: 'Landlord' }),
        tx(RB, '2025-05-12', 10000, { cpAccount: KB }),
        tx(RB, '2025-06-03', -300, { merchant: 'WOLT' }),
        tx(FIO, '2025-06-01', 100, { currency: 'EUR', cpName: 'Employer' }),
      ],
    );
  }

  it('computes balances, month flows and 12-month totals with foreign currency conversion', () => {
    const s = summarizeAccounts(sample(), defaultAccountsConfig(), TODAY, eur);
    const by = Object.fromEntries(s.accounts.map((a) => [a.id, a]));
    expect(s.accounts.map((a) => a.id)).toEqual([FIO, KB, RB]); // sorted by bank, then number
    expect(by[KB]).toMatchObject({ balance: 34000, balanceCzk: 34000, anchored: true, txCount: 4, firstDate: '2025-05-10', lastDate: '2025-06-01', balanceDate: TODAY, hidden: false });
    expect(by[RB]).toMatchObject({ balance: 9700, anchored: false, displayName: 'RB · Běžný · 222222', exportName: 'eKonto SMART', product: 'current' });
    expect(by[FIO]).toMatchObject({ balance: 600, balanceCzk: 15000, currency: 'EUR' });
    expect(s.totals.balanceCzk).toBe(58700);

    expect(s.months.map((m) => m.month)).toEqual(['2025-04', '2025-05', '2025-06']);
    const may = s.months[1];
    expect(may).toMatchObject({ income: 50000, expense: 0, net: 50000, invested: 2000, balance: 61500 });
    const jun = s.months[2];
    expect(jun).toMatchObject({ income: 2500, expense: 5300, net: -2800, invested: 0, balance: 58700 });
    expect(by[KB].monthly.map((m) => m.balance)).toEqual([1000, 39000, 34000]);

    expect(s.totals.income12m).toBe(52500);
    expect(s.totals.expense12m).toBe(5300);
    expect(s.totals.invested12m).toBe(2000);
    expect(s.totals.savingsRate12m).toBeCloseTo((52500 - 5300) / 52500, 10);
  });

  it('flags every movement and keeps them newest first with the account name', () => {
    const s = summarizeAccounts(sample(), { ...defaultAccountsConfig(), accounts: { [KB]: { alias: 'Hlavní' } } }, TODAY, eur);
    expect(s.txs.map((t) => t.date)).toEqual([...s.txs.map((t) => t.date)].sort().reverse());
    const flows = s.txs.map((t) => `${t.accountId}|${t.date}|${t.flow}`).sort();
    expect(flows).toEqual(
      [
        `${KB}|2025-05-10|income`,
        `${KB}|2025-05-12|transfer`,
        `${KB}|2025-05-20|investment`,
        `${KB}|2025-06-01|expense`,
        `${RB}|2025-05-12|transfer`,
        `${RB}|2025-06-03|expense`,
        `${FIO}|2025-06-01|income`,
      ].sort(),
    );
    expect(s.txs.find((t) => t.accountId === KB)!.accountName).toBe('Hlavní');
    expect(s.txs.find((t) => t.accountId === FIO)!.amountCzk).toBe(2500);
  });

  it('warns about a missing statement balance and about balances that do not match the movements', () => {
    const l = sample();
    l.accounts.get(KB)!.balancePoints.push({ date: '2025-05-31', balance: 40000 }); // movements say 39000
    const s = summarizeAccounts(l, defaultAccountsConfig(), TODAY, eur);
    const msgs = s.warnings.map((w) => `${w.source}: ${w.message}`);
    expect(msgs.some((m) => m.startsWith('RB · Běžný · 222222:') && m.includes('neobsahuje zůstatek'))).toBe(true);
    expect(msgs.some((m) => m.includes('nesedí s pohyby') && m.includes('1000.00 CZK'))).toBe(true);
  });

  it('a balance entered by the user anchors an account without stated balances (no warning)', () => {
    const cfg: AccountsConfig = { ...defaultAccountsConfig(), accounts: { [RB]: { anchor: { date: '2025-06-10', balance: 777 } } } };
    const s = summarizeAccounts(sample(), cfg, TODAY, eur);
    const rb = s.accounts.find((a) => a.id === RB)!;
    expect(rb).toMatchObject({ balance: 777, anchored: true, anchor: { date: '2025-06-10', balance: 777 } });
    expect(s.warnings.some((w) => w.message.includes('neobsahuje zůstatek'))).toBe(false);
    // 2025-05-31 balance = 777 - (-300 on 06-03) = 1077
    expect(rb.monthly.find((m) => m.month === '2025-05')!.balance).toBe(1077);
  });

  it('hidden accounts stay in the transaction list but are left out of balances and statistics', () => {
    const cfg: AccountsConfig = { ...defaultAccountsConfig(), accounts: { [RB]: { hidden: true }, [FIO]: { hidden: true } } };
    const s = summarizeAccounts(sample(), cfg, TODAY, eur);
    expect(s.accounts.find((a) => a.id === RB)!.hidden).toBe(true);
    expect(s.totals.balanceCzk).toBe(34000);
    expect(s.txs.filter((t) => t.accountId === RB)).toHaveLength(2);
    expect(s.months[2]).toMatchObject({ income: 0, expense: 5000, balance: 34000 });
    // the KB -> RB transfer is still recognised as a transfer
    expect(s.txs.find((t) => t.accountId === KB && t.date === '2025-05-12')!.flow).toBe('transfer');
    expect(s.totals.income12m).toBe(50000);
  });

  it('alias and product from the configuration override the inferred values', () => {
    const cfg: AccountsConfig = { ...defaultAccountsConfig(), accounts: { [RB]: { alias: 'Karta Jan', product: 'savings' } } };
    const a = summarizeAccounts(sample(), cfg, TODAY, eur).accounts.find((x) => x.id === RB)!;
    expect(a).toMatchObject({ displayName: 'Karta Jan', alias: 'Karta Jan', exportName: 'eKonto SMART', product: 'savings', productInferred: 'current' });
  });

  it('without a rate the account is excluded from the CZK total and a warning is added', () => {
    const s = summarizeAccounts(sample(), defaultAccountsConfig(), TODAY, () => null);
    const fio = s.accounts.find((a) => a.id === FIO)!;
    expect(fio.balanceCzk).toBeNull();
    expect(s.totals.balanceCzk).toBe(43700);
    expect(s.warnings.some((w) => w.message.includes('EUR') && w.message.includes('kurz'))).toBe(true);
    expect(s.txs.find((t) => t.accountId === FIO)!.amountCzk).toBeNull();
    expect(s.months[2].income).toBe(0); // the unconvertible income is not counted
    // a hidden account without a rate is not reported
    const hidden = summarizeAccounts(sample(), { ...defaultAccountsConfig(), accounts: { [FIO]: { hidden: true } } }, TODAY, () => null);
    expect(hidden.warnings.some((w) => w.message.includes('kurz'))).toBe(false);
  });

  it('only the last 12 months count for the totals; the savings rate is null without income', () => {
    const l = ledgerOf([{ id: KB }], [tx(KB, '2023-01-10', 1000), tx(KB, '2025-05-10', -40)]);
    const s = summarizeAccounts(l, defaultAccountsConfig(), TODAY, eur);
    expect(s.months[0].month).toBe('2023-01');
    expect(s.months).toHaveLength(30);
    expect(s.totals.income12m).toBe(0);
    expect(s.totals.expense12m).toBe(40);
    expect(s.totals.savingsRate12m).toBeNull();
    expect(s.totals.balanceCzk).toBe(960);
  });

  it('an empty ledger yields an empty summary', () => {
    const s = summarizeAccounts(emptyBankLedger(), defaultAccountsConfig(), TODAY, eur);
    expect(s).toMatchObject({ accounts: [], txs: [], months: [], totals: { balanceCzk: 0, income12m: 0, expense12m: 0, savingsRate12m: null, invested12m: 0 } });
  });

  it('data dated after today extend the balance date', () => {
    const l = ledgerOf([{ id: KB }], [tx(KB, '2025-07-01', 5)]);
    const a = summarizeAccounts(l, defaultAccountsConfig(), TODAY, eur).accounts[0];
    expect(a.balanceDate).toBe('2025-07-01');
    expect(a.balance).toBe(5);
  });
});

describe('buildBankLedger', () => {
  const f = (name: string, text: string) => ({ name, data: new Uint8Array(Buffer.from(text, 'utf-8')) });
  const rows = (id: string) => [{ id, date: '2025-01-05', amount: 10, type: 'Připsaný úrok' }];

  it('counts a transaction found in two overlapping files once and merges balances', () => {
    const a = fioCsv({ account: '2101234567', from: '2025-01-01', to: '2025-01-31', open: 0, close: 10, rows: rows('A1') });
    const b = fioCsv({ account: '2101234567', from: '2025-01-05', to: '2025-02-05', open: 0, close: 10, rows: rows('A1') });
    const l = buildBankLedger([f('a.csv', a), f('b.csv', b), f('notbank.csv', 'x;y\n1;2\n')]);
    expect(l.txs).toHaveLength(1);
    expect(l.accounts.size).toBe(1);
    expect(l.accounts.get('2101234567/2010')!.balancePoints.map((p) => p.date)).toEqual(['2024-12-31', '2025-01-04', '2025-01-31', '2025-02-05']);
    expect(l.warnings).toEqual([]);
  });

  it('a broken bank file becomes a warning instead of an exception', () => {
    const bad = '"Výpis č. 1/2025 z účtu ""x/2010"""\n"ID operace";"Datum";"Objem";"Měna"\n';
    const l = buildBankLedger([f('bad.csv', bad)]);
    expect(l.txs).toEqual([]);
    expect(l.warnings[0]).toMatchObject({ source: 'bad.csv' });
    expect(l.warnings[0].message).toContain('Chyba při načítání');
  });
});

describe('sanitizeAccountsConfig', () => {
  it('returns the default for anything that is not an object', () => {
    for (const bad of [null, undefined, 5, 'x', []]) expect(sanitizeAccountsConfig(bad)).toEqual(defaultAccountsConfig());
  });

  it('keeps valid account settings and trims them', () => {
    const c = sanitizeAccountsConfig({
      accounts: {
        '111/0100': { alias: '  Hlavní  ', product: 'savings', hidden: true, anchor: { date: '2025-01-31', balance: 12.5 } },
        '222/0100': { alias: 'x'.repeat(200) },
      },
    });
    expect(c.accounts['111/0100']).toEqual({ alias: 'Hlavní', product: 'savings', hidden: true, anchor: { date: '2025-01-31', balance: 12.5 } });
    expect(c.accounts['222/0100'].alias).toHaveLength(80);
  });

  it('drops malformed parts', () => {
    const c = sanitizeAccountsConfig({
      accounts: {
        '111/0100': { alias: '   ', product: 'bogus', hidden: 'yes', anchor: { date: '31.1.2025', balance: 1 } },
        '222/0100': { anchor: { date: '2025-01-31', balance: Number.NaN } },
        '333/0100': { anchor: { date: '2025-01-31', balance: '5' } },
        [`${'1'.repeat(70)}/0100`]: { alias: 'ok' },
        '444/0100': 'string',
        '555/0100': null,
      },
      ownAccounts: [null, 'x', { account: 'garbage' }, { account: 5 }, { label: 'no account' }],
    });
    expect(c.accounts).toEqual({});
    expect(c.ownAccounts).toEqual([]);
    expect(c.version).toBe(1);
  });

  it('normalises own accounts, defaults the kind and caps the list', () => {
    const c = sanitizeAccountsConfig({
      ownAccounts: [
        { account: '0000123456/0800', label: ' Spořka ', kind: 'own' },
        { account: '1000123456/5800', kind: 'investment' },
        { account: '77/0300', kind: 'whatever' },
      ],
    });
    expect(c.ownAccounts).toEqual([
      { account: '123456/0800', label: 'Spořka', kind: 'own' },
      { account: '1000123456/5800', label: undefined, kind: 'investment' },
      { account: '77/0300', label: undefined, kind: 'own' },
    ]);
    const many = sanitizeAccountsConfig({ ownAccounts: Array.from({ length: 300 }, (_, i) => ({ account: `${1000 + i}/0100` })) });
    expect(many.ownAccounts).toHaveLength(200);
  });
});

describe('account names', () => {
  it('default name: bank, product and number, plus a foreign currency', () => {
    expect(defaultAccountName({ bank: 'RB', number: '1234567890', currency: 'CZK' }, 'current')).toBe('RB · Běžný · 1234567890');
    expect(defaultAccountName({ bank: 'RB', number: '1234567890', currency: 'USD' }, 'current')).toBe('RB · Běžný · 1234567890 · USD');
    expect(defaultAccountName({ bank: 'KB', number: '19-1234567890', currency: 'CZK' }, 'savings')).toBe('KB · Spořicí · 19-1234567890');
    expect(defaultAccountName({ bank: 'FIO', number: '2101112223', currency: 'CZK' }, 'term')).toBe('Fio · Termínovaný · 2101112223');
  });

  const view = (displayName: string, defaultName: string) => ({ displayName, defaultName }) as AccountView;
  it('the same alias on two accounts gets the default name appended; unique names stay', () => {
    const list = [view('Rodina', 'RB · Běžný · 1'), view('Rodina', 'RB · Spořicí · 2'), view('Výplata', 'KB · Běžný · 3')];
    uniqueNames(list);
    expect(list.map((a) => a.displayName)).toEqual(['Rodina (RB · Běžný · 1)', 'Rodina (RB · Spořicí · 2)', 'Výplata']);
  });

  it('two accounts with the export name of the holder no longer share a name', () => {
    const SAV = '222230/5500';
    const l = ledgerOfNames();
    const s = summarizeAccounts(l, { ...defaultAccountsConfig(), accounts: { [SAV]: { product: 'savings' } } }, '2025-06-15', () => null);
    expect(s.accounts.map((a) => a.displayName)).toEqual(['RB · Běžný · 222222', 'RB · Spořicí · 222230']);
    expect(new Set(s.txs.map((t) => t.accountName)).size).toBe(2);

    function ledgerOfNames(): BankLedger {
      const ledger = emptyBankLedger();
      for (const [id, number] of [['222222/5500', '222222'], [SAV, '222230']]) {
        ledger.accounts.set(id, { id, bank: 'RB', number, currency: 'CZK', name: 'JAN TESTOVACI', balancePoints: [{ date: '2025-05-31', balance: 100 }] } as BankAccountData);
        ledger.txs.push({ key: `k${number}`, bank: 'RB', accountId: id, date: '2025-05-10', amount: 10, currency: 'CZK', bankType: 'Příchozí úhrada' } as BankTx);
      }
      return ledger;
    }
  });
});

describe('uniqueNames edge cases', () => {
  it('an alias equal to the renamed name of another account still ends unique', () => {
    const list = [
      { displayName: 'Rodina', defaultName: 'RB · Běžný · 1' },
      { displayName: 'Rodina', defaultName: 'RB · Spořicí · 2' },
      { displayName: 'Rodina (RB · Běžný · 1)', defaultName: 'KB · Běžný · 3' },
    ];
    uniqueNames(list);
    expect(new Set(list.map((a) => a.displayName)).size).toBe(3);
  });
  it('an alias equal to another account default name: only the aliased account changes', () => {
    const list = [
      { displayName: 'RB · Běžný · 1', defaultName: 'RB · Běžný · 1' },
      { displayName: 'RB · Běžný · 1', defaultName: 'KB · Běžný · 3' },
    ];
    uniqueNames(list);
    expect(list.map((a) => a.displayName)).toEqual(['RB · Běžný · 1', 'RB · Běžný · 1 (KB · Běžný · 3)']);
  });
});
