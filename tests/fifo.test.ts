import { describe, expect, it } from 'vitest';
import { passesTimeTest, runFifo, timeTestDate } from '../src/core/fifo.js';
import { fakeConv, inst, ledgerWith, trade } from './helpers.js';

const A = 'US0000000001';
const B = 'US0000000002';

describe('time test (3 years)', () => {
  it('requires holding to exceed 3 years', () => {
    expect(timeTestDate('2020-01-15')).toBe('2023-01-16');
    expect(passesTimeTest('2020-01-15', '2023-01-15')).toBe(false);
    expect(passesTimeTest('2020-01-15', '2023-01-16')).toBe(true);
  });
  it('handles 29 February', () => {
    expect(timeTestDate('2020-02-29')).toBe('2023-03-01');
  });
});

describe('FIFO', () => {
  it('consumes oldest lots first and splits a sale across lots', () => {
    const l = ledgerWith(
      [inst(A)],
      [
        trade(A, '2021-01-10', 10, 100, { fees: [{ amount: 2, currency: 'USD' }] }),
        trade(A, '2022-01-10', 10, 200),
        trade(A, '2024-06-01', -15, 300, { fees: [{ amount: 3, currency: 'USD' }] }),
      ],
    );
    const r = runFifo(l, fakeConv);
    expect(r.warnings).toEqual([]);
    expect(r.realizations).toHaveLength(2);
    const [r1, r2] = r.realizations;
    expect(r1.qty).toBe(10);
    expect(r1.acqDate).toBe('2021-01-10');
    expect(r1.proceedsCzk).toBeCloseTo(10 * 300 * 20);
    expect(r1.costCzk).toBeCloseTo(10 * 100 * 20);
    expect(r1.buyFeesCzk).toBeCloseTo(2 * 20);
    expect(r1.sellFeesCzk).toBeCloseTo((3 * 20 * 10) / 15);
    expect(r1.timeTestPassed).toBe(true);
    expect(r2.qty).toBe(5);
    expect(r2.costCzk).toBeCloseTo(5 * 200 * 20);
    expect(r2.timeTestPassed).toBe(false);
    expect(r2.gainCzk).toBeCloseTo(5 * 300 * 20 - (3 * 20 * 5) / 15 - 5 * 200 * 20);

    expect(r.openLots).toHaveLength(1);
    expect(r.openLots[0].qty).toBe(5);
    expect(r.openLots[0].costCzk).toBeCloseTo(5 * 200 * 20);
  });

  it('keeps acquisition date and cost through a split', () => {
    const l = ledgerWith(
      [inst(A)],
      [trade(A, '2020-03-01', 2, 1000), trade(A, '2023-06-01', -20, 120)],
      [{ kind: 'SPLIT', broker: 'DEGIRO', instrumentId: A, date: '2022-06-01', dateTime: '2022-06-01T00:00:00', ratio: 10, note: 'split' }],
    );
    const r = runFifo(l, fakeConv);
    expect(r.openLots).toHaveLength(0);
    expect(r.realizations).toHaveLength(1);
    expect(r.realizations[0].qty).toBe(20);
    expect(r.realizations[0].acqDate).toBe('2020-03-01');
    expect(r.realizations[0].costCzk).toBeCloseTo(2000 * 20);
    expect(r.realizations[0].timeTestPassed).toBe(true);
  });

  it('moves lots to the new instrument on conversion', () => {
    const l = ledgerWith(
      [inst(A), inst(B)],
      [trade(A, '2021-01-01', 10, 50), trade(B, '2021-09-01', -5, 120)],
      [{ kind: 'CONVERSION', broker: 'DEGIRO', fromId: A, toId: B, date: '2021-05-01', dateTime: '2021-05-01T00:00:00', ratio: 0.5, note: 'merger' }],
    );
    const r = runFifo(l, fakeConv);
    expect(r.warnings).toEqual([]);
    expect(r.realizations[0].instrumentId).toBe(B);
    expect(r.realizations[0].acqDate).toBe('2021-01-01');
    expect(r.realizations[0].costCzk).toBeCloseTo(500 * 20);
    expect(r.openLots).toHaveLength(0);
  });

  it('creates zero-cost lot for free shares', () => {
    const l = ledgerWith(
      [inst(A)],
      [trade(A, '2022-01-01', -3, 10)],
      [{ kind: 'FREE_SHARES', broker: 'DEGIRO', instrumentId: A, date: '2021-01-01', dateTime: '2021-01-01T00:00:00', quantity: 3, note: 'spin-off' }],
    );
    const r = runFifo(l, fakeConv);
    expect(r.realizations[0].origin).toBe('FREE');
    expect(r.realizations[0].costCzk).toBe(0);
    expect(r.realizations[0].gainCzk).toBeCloseTo(600);
  });

  it('warns and uses zero cost when a sale has no matching buy', () => {
    const l = ledgerWith([inst(A)], [trade(A, '2022-01-01', -1, 10)]);
    const r = runFifo(l, fakeConv);
    expect(r.warnings).toHaveLength(1);
    expect(r.realizations[0].costCzk).toBe(0);
    expect(r.realizations[0].timeTestPassed).toBe(false);
  });

  it('prefers exact CZK settlement amount', () => {
    const l = ledgerWith([inst(A)], [trade(A, '2022-01-01', 1, 10, { amountCzk: 215 }), trade(A, '2022-02-01', -1, 12, { amountCzk: 250 })]);
    const r = runFifo(l, fakeConv);
    expect(r.realizations[0].gainCzk).toBeCloseTo(35);
  });

  it('assigns deterministic lot ids', () => {
    const mk = () => ledgerWith([inst(A)], [trade(A, '2022-01-01', 1, 10, { id: 'x1' }), trade(A, '2022-02-01', 1, 12, { id: 'x2' })]);
    expect(runFifo(mk(), fakeConv).openLots.map((l) => l.id)).toEqual(runFifo(mk(), () => 1).openLots.map((l) => l.id));
  });
});
