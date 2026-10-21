export type Broker = 'DEGIRO' | 'XTB';

export type AssetType = 'STOCK' | 'ETF' | 'FUND' | 'RIGHT' | 'CFD' | 'OTHER';

export interface Money {
  amount: number;
  currency: string;
}

export interface Instrument {
  /** ISIN when known, otherwise `${broker}:${symbol}` */
  id: string;
  isin?: string;
  name: string;
  type: AssetType;
  /** Trading currency (price currency, GBX normalised to GBP) */
  currency: string;
  /** Symbol used by the broker (XTB ticker) */
  brokerSymbol?: string;
  /** Degiro exchange code (NDQ, XET, ...) */
  exchange?: string;
  /** ISO-2 country of the issuer (tax source country for dividends), default derived from ISIN */
  country?: string;
}

export interface Trade {
  id: string;
  broker: Broker;
  instrumentId: string;
  /** ISO local date-time `YYYY-MM-DDTHH:mm:ss` */
  dateTime: string;
  /** ISO date `YYYY-MM-DD` */
  date: string;
  /** Positive = buy, negative = sell */
  quantity: number;
  /** Price per unit in `currency` */
  price: number;
  /** Price / amount currency (GBX normalised to GBP) */
  currency: string;
  /** Absolute gross value in `currency` */
  amount: number;
  /** Positive fee amounts (broker fees, AutoFX, transaction taxes, stamp duty) */
  fees: Money[];
  /** Exact CZK settlement amount (absolute) when the account is settled in CZK (XTB) */
  amountCzk?: number;
  orderId?: string;
}

export type CorporateAction =
  | {
      kind: 'SPLIT';
      broker: Broker;
      instrumentId: string;
      dateTime: string;
      date: string;
      ratio: number;
      note: string;
    }
  | {
      kind: 'CONVERSION';
      broker: Broker;
      fromId: string;
      toId: string;
      dateTime: string;
      date: string;
      /** new quantity per one old unit */
      ratio: number;
      note: string;
    }
  | {
      kind: 'FREE_SHARES';
      broker: Broker;
      instrumentId: string;
      dateTime: string;
      date: string;
      quantity: number;
      note: string;
    };

export type CashKind =
  | 'DIVIDEND'
  | 'DIVIDEND_TAX'
  | 'CAPITAL_RETURN'
  | 'INTEREST'
  | 'INTEREST_TAX'
  | 'FEE'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'CORPORATE_CASH'
  | 'DERIVATIVE_PNL'
  | 'CASH_FUND';

export type FeeCategory = 'EXCHANGE_CONNECTION' | 'ADR' | 'OTHER';

export interface CashEvent {
  id: string;
  broker: Broker;
  kind: CashKind;
  /** Booking date-time */
  dateTime: string;
  /** Economic / value date used for tax year assignment */
  date: string;
  /** Signed amount in `currency` (income positive, cost negative) */
  amount: number;
  currency: string;
  instrumentId?: string;
  description: string;
  feeCategory?: FeeCategory;
}

export interface ImportWarning {
  source: string;
  message: string;
}

export interface BrokerQuote {
  price: number;
  quantity?: number;
  valueCzk?: number;
  asOf: string;
}

export interface Ledger {
  instruments: Map<string, Instrument>;
  trades: Trade[];
  actions: CorporateAction[];
  cash: CashEvent[];
  warnings: ImportWarning[];
  /** Latest broker-reported valuations (XTB open positions) keyed by instrument id */
  brokerQuotes: Map<string, BrokerQuote>;
  sources: { broker: Broker; file: string; rows: number }[];
}

export function emptyLedger(): Ledger {
  return {
    instruments: new Map(),
    trades: [],
    actions: [],
    cash: [],
    warnings: [],
    brokerQuotes: new Map(),
    sources: [],
  };
}
