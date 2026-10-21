import { parse } from 'csv-parse/sync';
import type { CashEvent, CashKind, FeeCategory, Instrument, Ledger, Money, Trade } from '../types.js';
import { dmyToIso, groupBy, normaliseCurrency, parseNum } from '../util.js';

const BROKER = 'DEGIRO' as const;

function readCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  return parse(clean, { relax_column_count: true, skip_empty_lines: true }) as string[][];
}

function findCol(header: string[], ...names: (string | RegExp)[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => (typeof n === 'string' ? h.trim().toLowerCase() === n.toLowerCase() : n.test(h.trim())));
    if (i >= 0) return i;
  }
  return -1;
}

const ETF_RE = /\b(UCITS|ETF|ISHARES|VANGUARD|XTRACKERS|AMUNDI|SPDR|LYXOR|INVESCO|WISDOMTREE)\b/i;

export function guessAssetType(name: string): Instrument['type'] {
  if (/CASH FUND|MONEY MARKET|PENĚŽNÍ/i.test(name)) return 'FUND';
  if (ETF_RE.test(name)) return 'ETF';
  return 'STOCK';
}

function upsertInstrument(ledger: Ledger, isin: string, name: string, currency: string | undefined, exchange: string | undefined, dateTime: string) {
  const existing = ledger.instruments.get(isin) as (Instrument & { _seen?: string }) | undefined;
  const cleanName = name.replace(/\s*-\s*NON TRADEABLE$/i, '').trim();
  if (!existing) {
    const inst: Instrument & { _seen?: string } = {
      id: isin,
      isin,
      name: cleanName || isin,
      type: guessAssetType(cleanName),
      currency: currency ?? 'EUR',
      exchange,
      country: isin.slice(0, 2),
      _seen: dateTime,
    };
    ledger.instruments.set(isin, inst);
    return;
  }
  // keep the most recent (and tradeable) name / exchange / currency
  if (!existing._seen || dateTime >= existing._seen) {
    if (cleanName && !/NON TRADEABLE/i.test(name)) existing.name = cleanName;
    if (currency) existing.currency = currency;
    if (exchange && exchange !== 'DEG') existing.exchange = exchange;
    existing._seen = dateTime;
  }
}

interface TxRow {
  line: number;
  date: string;
  dateTime: string;
  product: string;
  isin: string;
  exchange: string;
  quantity: number;
  price: number;
  currency: string;
  amount: number; // signed local value, normalised currency
  fees: Money[];
  orderId: string;
}

export function parseDegiroTransactions(text: string, ledger: Ledger, file = 'Transactions.csv'): void {
  const rows = readCsv(text);
  if (rows.length === 0) return;
  const h = rows[0];
  const iDate = findCol(h, 'Date', 'Datum');
  const iTime = findCol(h, 'Time', 'Čas', 'Tijd');
  const iProduct = findCol(h, 'Product', 'Produkt');
  const iIsin = findCol(h, 'ISIN');
  const iExchange = findCol(h, 'Reference exchange', 'Reference', 'Burza', 'Beurs');
  const iQty = findCol(h, 'Quantity', 'Počet', 'Aantal');
  const iPrice = findCol(h, 'Price', 'Cena', 'Koers');
  const iLocal = findCol(h, 'Local value', 'Hodnota v domácí měně', 'Lokale waarde');
  const iFee = findCol(h, /^Transaction and\/or third/i, /^Transaction costs/i, /^Transakční/i, /^Transactiekosten/i);
  const iAutoFx = findCol(h, /^AutoFX/i);
  const iOrder = findCol(h, 'Order ID', 'Order Id', 'ID objednávky');
  const iValueBase = findCol(h, /^Value (EUR|CZK|USD|GBP|CHF)$/i, /^Hodnota (EUR|CZK)$/i);
  if ([iDate, iTime, iProduct, iIsin, iQty, iPrice, iLocal, iOrder].some((i) => i < 0)) {
    throw new Error(`${file}: nerozpoznaná hlavička Degiro Transactions (${h.join(', ')})`);
  }
  const baseCurrencyMatch = iValueBase >= 0 ? /(EUR|CZK|USD|GBP|CHF)/i.exec(h[iValueBase]) : null;
  const baseCurrency = baseCurrencyMatch ? baseCurrencyMatch[1].toUpperCase() : 'EUR';
  const feeHasOwnCurrency = iFee >= 0 && !/(EUR|CZK|USD)$/i.test(h[iFee].trim());

  const txRows: TxRow[] = [];
  for (let li = 1; li < rows.length; li++) {
    const r = rows[li];
    if (!r[iDate] || !r[iIsin]) continue;
    const date = dmyToIso(r[iDate]);
    const dateTime = `${date}T${(r[iTime] || '00:00').padStart(5, '0')}:00`;
    const qty = parseNum(r[iQty]);
    const rawPrice = parseNum(r[iPrice]);
    const priceCur = (r[iPrice + 1] || '').trim();
    const rawLocal = parseNum(r[iLocal]);
    const localCur = (r[iLocal + 1] || priceCur).trim();
    const local = normaliseCurrency(rawLocal, localCur);
    const price = normaliseCurrency(rawPrice, priceCur || localCur);
    const fees: Money[] = [];
    if (iFee >= 0) {
      const f = parseNum(r[iFee]);
      const fCur = feeHasOwnCurrency ? (r[iFee + 1] || baseCurrency).trim() : baseCurrency;
      if (Number.isFinite(f) && f !== 0) fees.push({ amount: Math.abs(f), currency: fCur });
    }
    if (iAutoFx >= 0) {
      const f = parseNum(r[iAutoFx]);
      if (Number.isFinite(f) && f !== 0) fees.push({ amount: Math.abs(f), currency: baseCurrency });
    }
    txRows.push({
      line: li + 1,
      date,
      dateTime,
      product: r[iProduct],
      isin: r[iIsin].trim(),
      exchange: iExchange >= 0 ? r[iExchange].trim() : '',
      quantity: qty,
      price: price.amount,
      currency: local.currency,
      amount: local.amount,
      fees,
      orderId: (r[iOrder] || '').trim(),
    });
    upsertInstrument(ledger, r[iIsin].trim(), r[iProduct], local.currency, iExchange >= 0 ? r[iExchange].trim() : undefined, dateTime);
  }
  ledger.sources.push({ broker: BROKER, file, rows: txRows.length });

  const regular = txRows.filter((t) => t.orderId);
  const corporate = txRows.filter((t) => !t.orderId);

  for (const t of regular) ledger.trades.push(toTrade(t));

  // Corporate actions: rows without order id, grouped by timestamp
  const groups = groupBy(corporate, (t) => t.dateTime);
  for (const [dateTime, rowsInGroup] of groups) {
    const date = dateTime.slice(0, 10);
    const byIsin = groupBy(rowsInGroup, (t) => t.isin);
    const negIsins: string[] = [];
    const posIsins: string[] = [];
    for (const [isin, rs] of byIsin) {
      const q = rs.reduce((s, x) => s + x.quantity, 0);
      const hasNeg = rs.some((x) => x.quantity < 0);
      const hasPos = rs.some((x) => x.quantity > 0);
      if (hasNeg && hasPos) {
        const neg = -rs.filter((x) => x.quantity < 0).reduce((s, x) => s + x.quantity, 0);
        const pos = rs.filter((x) => x.quantity > 0).reduce((s, x) => s + x.quantity, 0);
        if (Math.abs(q) < 1e-9) continue; // product / exchange change, no economic effect
        ledger.actions.push({
          kind: 'SPLIT',
          broker: BROKER,
          instrumentId: isin,
          dateTime,
          date,
          ratio: pos / neg,
          note: `Split ${neg} → ${pos} (${rs[0].product})`,
        });
        continue;
      }
      if (hasNeg) negIsins.push(isin);
      else if (hasPos) posIsins.push(isin);
    }
    if (negIsins.length === 1 && posIsins.length === 1) {
      const neg = byIsin.get(negIsins[0])!;
      const pos = byIsin.get(posIsins[0])!;
      const negQty = -neg.reduce((s, x) => s + x.quantity, 0);
      const posQty = pos.reduce((s, x) => s + x.quantity, 0);
      ledger.actions.push({
        kind: 'CONVERSION',
        broker: BROKER,
        fromId: negIsins[0],
        toId: posIsins[0],
        dateTime,
        date,
        ratio: posQty / negQty,
        note: `Výměna ${negQty}× ${neg[0].product} → ${posQty}× ${pos[0].product}`,
      });
      continue;
    }
    for (const isin of negIsins) {
      // e.g. cash take-over: disposal for cash
      for (const t of byIsin.get(isin)!) ledger.trades.push(toTrade(t));
    }
    for (const isin of posIsins) {
      for (const t of byIsin.get(isin)!) {
        if (Math.abs(t.amount) < 1e-9 || t.price === 0) {
          ledger.actions.push({
            kind: 'FREE_SHARES',
            broker: BROKER,
            instrumentId: isin,
            dateTime,
            date,
            quantity: t.quantity,
            note: `Připsání ${t.quantity}× ${t.product} (spin-off / práva) s nulovou pořizovací cenou`,
          });
        } else {
          ledger.trades.push(toTrade(t));
        }
      }
    }
    if (negIsins.length > 1 || (negIsins.length === 1 && posIsins.length > 1)) {
      ledger.warnings.push({
        source: file,
        message: `Nejednoznačná korporátní akce ${dateTime} (${[...byIsin.keys()].join(', ')}) – zpracováno jako prodej/připsání.`,
      });
    }
  }
}

function toTrade(t: TxRow): Trade {
  return {
    id: `DEGIRO:${t.line}:${t.orderId || 'corp'}`,
    broker: BROKER,
    instrumentId: t.isin,
    dateTime: t.dateTime,
    date: t.date,
    quantity: t.quantity,
    price: t.price,
    currency: t.currency,
    amount: Math.abs(t.amount),
    fees: [...t.fees],
    orderId: t.orderId || undefined,
  };
}

interface Rule {
  re: RegExp;
  kind: CashKind | 'IGNORE' | 'TRANSACTION_TAX';
  fee?: FeeCategory;
}

const ACCOUNT_RULES: Rule[] = [
  { re: /^(Dividenda|Dividend|Dividende)$/i, kind: 'DIVIDEND' },
  { re: /^(Daň z dividendy|Dividend Tax|Dividendbelasting|Dividendensteuer)$/i, kind: 'DIVIDEND_TAX' },
  { re: /(Vratka kapitálu|Capital Return|Return of Capital|Kapitaalterugbetaling)/i, kind: 'CAPITAL_RETURN' },
  { re: /(transakční da[nňń]|Transaction Tax|kolkovné|Stamp Duty|Financial Transaction Tax|Taxe sur les transactions)/i, kind: 'TRANSACTION_TAX' },
  { re: /(DEGIRO Transaction and\/or third party fees|Transakční poplatk|Transaction fee|Transactiekosten)/i, kind: 'IGNORE' },
  { re: /(poplatek za Obchodování na zahraničních burzách|Exchange Connection Fee|connection fee|Aansluitingskosten)/i, kind: 'FEE', fee: 'EXCHANGE_CONNECTION' },
  { re: /(ADR\/GDR Pass-Through)/i, kind: 'FEE', fee: 'ADR' },
  { re: /(Flatex Interest Income|^Flatex Interest$|^Úrok$|^Interest$|^Rente$|Debit interest|Úrok z)/i, kind: 'INTEREST' },
  { re: /^(Vklad|flatex Deposit|Deposit|iDEAL Deposit|SOFORT Deposit|Storting|Reservation iDEAL)/i, kind: 'DEPOSIT' },
  { re: /^(Výběr|Withdrawal|flatex Withdrawal|Terugstorting|Processed Flatex Withdrawal)/i, kind: 'WITHDRAWAL' },
  { re: /^(Náklady akcie|Cash in lieu|Fractional share|Fractie)/i, kind: 'CORPORATE_CASH' },
  { re: /Změna ceny Peněžního Fondu|Money Market fund price change|Geldmarktfonds Preisänderung/i, kind: 'CASH_FUND' },
  {
    re: /^(FX vyučtování|FX Credit|FX Debit|Valuta|Degiro Cash Sweep|Transfer (to|from) your Cash Account|Konverze Peněžního Fondu|Money Market fund conversion|Nákup |Prodej |Buy |Sell |Take over|Merger|Spin off|Změna produktu|Product change|ÚPRAVA SPLITU|Stock split|Split|Změna ISIN|ISIN change|Rights issue|Převod)/i,
    kind: 'IGNORE',
  },
  { re: /^[\d\s\u00a0.,]+(EUR|CZK|USD)$/i, kind: 'IGNORE' },
];

export function parseDegiroAccount(text: string, ledger: Ledger, file = 'Account.csv'): void {
  const rows = readCsv(text);
  if (rows.length === 0) return;
  const h = rows[0];
  const iDate = findCol(h, 'Date', 'Datum');
  const iTime = findCol(h, 'Time', 'Čas', 'Tijd');
  const iValueDate = findCol(h, 'Value date', 'Datum valuty', 'Valutadatum');
  const iProduct = findCol(h, 'Product', 'Produkt');
  const iIsin = findCol(h, 'ISIN');
  const iDesc = findCol(h, 'Description', 'Popis', 'Omschrijving');
  const iChange = findCol(h, 'Change', 'Změna', 'Mutatie');
  const iOrder = findCol(h, 'Order Id', 'Order ID', 'ID objednávky');
  if ([iDate, iDesc, iChange, iIsin].some((i) => i < 0)) {
    throw new Error(`${file}: nerozpoznaná hlavička Degiro Account (${h.join(', ')})`);
  }

  type Raw = CashEvent & { orderId?: string };
  const raw: Raw[] = [];
  const txTaxes: { isin: string; date: string; orderId?: string; fee: Money; desc: string }[] = [];
  let count = 0;
  for (let li = 1; li < rows.length; li++) {
    const r = rows[li];
    if (!r[iDate]) continue;
    count++;
    const desc = (r[iDesc] || '').trim();
    const rule = ACCOUNT_RULES.find((x) => x.re.test(desc));
    if (!rule) {
      ledger.warnings.push({ source: file, message: `Neznámý typ pohybu na řádku ${li + 1}: "${desc}"` });
      continue;
    }
    if (rule.kind === 'IGNORE') continue;
    const cur = (r[iChange] || '').trim();
    const amt = parseNum(r[iChange + 1]);
    if (!cur || !Number.isFinite(amt) || amt === 0) continue;
    const date = dmyToIso(r[iDate]);
    const valueDate = iValueDate >= 0 && r[iValueDate] ? dmyToIso(r[iValueDate]) : date;
    const dateTime = `${date}T${(r[iTime] || '00:00').padStart(5, '0')}:00`;
    const isin = (r[iIsin] || '').trim() || undefined;
    const money = normaliseCurrency(amt, cur);
    if (isin) upsertInstrument(ledger, isin, r[iProduct] || isin, undefined, undefined, '0000');
    if (rule.kind === 'TRANSACTION_TAX') {
      txTaxes.push({ isin: isin ?? '', date, orderId: iOrder >= 0 ? (r[iOrder] || '').trim() || undefined : undefined, fee: { amount: -money.amount, currency: money.currency }, desc });
      continue;
    }
    raw.push({
      id: `DEGIRO:A${li + 1}`,
      broker: BROKER,
      kind: rule.kind,
      dateTime,
      date: rule.kind === 'DIVIDEND' || rule.kind === 'DIVIDEND_TAX' || rule.kind === 'CAPITAL_RETURN' ? valueDate : date,
      amount: money.amount,
      currency: money.currency,
      instrumentId: isin,
      description: desc,
      feeCategory: rule.fee,
    });
  }
  ledger.sources.push({ broker: BROKER, file, rows: count });

  // Attach transaction taxes / stamp duties to the matching trade (as acquisition / disposal cost)
  const byOrder = new Map<string, Trade>();
  for (const t of ledger.trades) if (t.broker === BROKER && t.orderId) byOrder.set(t.orderId, t);
  for (const tt of txTaxes) {
    let trade = tt.orderId ? byOrder.get(tt.orderId) : undefined;
    if (!trade) {
      trade = ledger.trades.find((t) => t.broker === BROKER && t.instrumentId === tt.isin && t.date === tt.date);
    }
    if (trade) trade.fees.push(tt.fee);
    else
      raw.push({
        id: `DEGIRO:TT:${tt.isin}:${tt.date}`,
        broker: BROKER,
        kind: 'FEE',
        dateTime: `${tt.date}T00:00:00`,
        date: tt.date,
        amount: -tt.fee.amount,
        currency: tt.fee.currency,
        instrumentId: tt.isin || undefined,
        description: tt.desc,
        feeCategory: 'OTHER',
      });
  }

  // Net dividend corrections / reversals by (kind, isin, value date, currency)
  const nettable = new Set<CashKind>(['DIVIDEND', 'DIVIDEND_TAX', 'CAPITAL_RETURN']);
  const keep: CashEvent[] = [];
  const net = new Map<string, Raw>();
  for (const e of raw) {
    if (!nettable.has(e.kind)) {
      keep.push(e);
      continue;
    }
    const key = `${e.kind}|${e.instrumentId}|${e.date}|${e.currency}`;
    const ex = net.get(key);
    if (ex) {
      ex.amount += e.amount;
      if (e.dateTime > ex.dateTime) ex.dateTime = e.dateTime;
    } else net.set(key, { ...e });
  }
  for (const e of net.values()) if (Math.abs(e.amount) > 0.004) keep.push(e);
  ledger.cash.push(...keep);
}
