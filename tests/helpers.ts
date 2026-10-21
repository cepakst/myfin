import type { Converter } from '../src/core/fifo.js';
import { emptyLedger, type CorporateAction, type Instrument, type Ledger, type Trade } from '../src/core/types.js';

/** Fixed fake rates: 1 USD = 20 CZK, 1 EUR = 25 CZK */
export const FAKE_RATES: Record<string, number> = { CZK: 1, USD: 20, EUR: 25 };
export const fakeConv: Converter = (amount, currency) => amount * FAKE_RATES[currency];

export function inst(id: string, currency = 'USD', name = id): Instrument {
  return { id, isin: id, name, type: 'STOCK', currency, country: id.slice(0, 2) };
}

let seq = 0;
export function trade(instrumentId: string, date: string, quantity: number, price: number, opts: Partial<Trade> = {}): Trade {
  seq++;
  const currency = opts.currency ?? 'USD';
  return {
    id: `T${seq}`,
    broker: 'DEGIRO',
    instrumentId,
    dateTime: `${date}T10:00:${String(seq % 60).padStart(2, '0')}`,
    date,
    quantity,
    price,
    currency,
    amount: Math.abs(quantity) * price,
    fees: [],
    ...opts,
  };
}

export function ledgerWith(instruments: Instrument[], trades: Trade[], actions: CorporateAction[] = []): Ledger {
  const l = emptyLedger();
  for (const i of instruments) l.instruments.set(i.id, i);
  l.trades.push(...trades);
  l.actions.push(...actions);
  return l;
}
