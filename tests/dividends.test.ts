import { describe, expect, it } from 'vitest';
import { buildDividendPayments, dividendYearReport } from '../src/core/tax/dividends.js';
import { emptyLedger, type CashEvent } from '../src/core/types.js';
import { fakeConv, inst } from './helpers.js';

function cash(kind: CashEvent['kind'], instrumentId: string, date: string, amount: number, currency = 'USD'): CashEvent {
  return { id: `${kind}${instrumentId}${date}${amount}`, broker: 'DEGIRO', kind, dateTime: `${date}T08:00:00`, date, amount, currency, instrumentId, description: kind };
}

function setup() {
  const l = emptyLedger();
  l.instruments.set('US0000000001', inst('US0000000001'));
  l.instruments.set('FR0000000001', inst('FR0000000001', 'EUR'));
  l.instruments.set('CZ0000000001', inst('CZ0000000001', 'CZK'));
  l.cash.push(
    cash('DIVIDEND', 'US0000000001', '2024-03-01', 100),
    cash('DIVIDEND_TAX', 'US0000000001', '2024-03-01', -15),
    cash('DIVIDEND', 'FR0000000001', '2024-05-01', 100, 'EUR'),
    cash('DIVIDEND_TAX', 'FR0000000001', '2024-05-01', -25, 'EUR'),
    cash('DIVIDEND', 'CZ0000000001', '2024-06-01', 1000, 'CZK'),
    cash('DIVIDEND_TAX', 'CZ0000000001', '2024-06-01', -150, 'CZK'),
    cash('DIVIDEND', 'US0000000001', '2023-03-01', 10),
  );
  return l;
}

describe('dividends', () => {
  it('groups gross and withholding per payment and computes credit', () => {
    const ps = buildDividendPayments(setup(), fakeConv, fakeConv, { treatyOverrides: { FR: 0.15 } });
    const us = ps.find((p) => p.country === 'US' && p.year === 2024)!;
    expect(us.grossCzk).toBe(2000);
    expect(us.withheldCzk).toBe(300);
    expect(us.creditableCzk).toBe(300);
    expect(us.czTaxCzk).toBe(300);
    expect(us.dueCzk).toBe(0);
    expect(us.reclaimable).toBe(0);
  });

  it('limits credit to treaty rate and reports reclaimable excess', () => {
    const ps = buildDividendPayments(setup(), fakeConv, fakeConv, { treatyOverrides: { FR: 0.15 } });
    const fr = ps.find((p) => p.country === 'FR')!;
    expect(fr.grossCzk).toBe(2500);
    expect(fr.withheldCzk).toBe(625);
    expect(fr.creditableCzk).toBeCloseTo(375);
    expect(fr.dueCzk).toBeCloseTo(0);
    expect(fr.reclaimable).toBeCloseTo(10);
    expect(fr.reclaimableCzk).toBeCloseTo(250);
  });

  it('pays the difference when foreign withholding is below 15 %', () => {
    const ps = buildDividendPayments(setup(), fakeConv, fakeConv, { treatyOverrides: { FR: 0.1 } });
    const fr = ps.find((p) => p.country === 'FR')!;
    expect(fr.creditableCzk).toBeCloseTo(250);
    expect(fr.dueCzk).toBeCloseTo(125);
  });

  it('treats Czech dividends as final-taxed and keeps them out of the foreign summary', () => {
    const ps = buildDividendPayments(setup(), fakeConv, fakeConv, { treatyOverrides: { FR: 0.15 } });
    const rep = dividendYearReport(ps, 2024);
    expect(rep.domesticFinal.grossCzk).toBe(1000);
    expect(rep.foreign.grossCzk).toBe(4500);
    expect(rep.byCountry.map((c) => c.country).sort()).toEqual(['FR', 'US']);
    expect(rep.payments).toHaveLength(3);
  });

  it('respects country overrides (e.g. ADR)', () => {
    const ps = buildDividendPayments(setup(), fakeConv, fakeConv, { countryOverrides: { US0000000001: 'TW' } });
    expect(ps.filter((p) => p.instrumentId === 'US0000000001').every((p) => p.country === 'TW')).toBe(true);
  });
});
