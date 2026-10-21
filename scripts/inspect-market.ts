import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildLedger } from '../src/core/parsers/index.js';
import { MarketData } from '../src/server/market.js';
function walk(d: string): string[] { return readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }); }
const l = await buildLedger(walk('exports').map(p => ({ name: p, data: new Uint8Array(readFileSync(p)) })));
const md = new MarketData(console.log);
const t0 = Date.now();
await md.loadAll(l, {});
console.log('time', (Date.now()-t0)/1000);
const m = md.symbolMap();
const none = [...l.instruments.values()].filter(i => !m[i.id]?.symbol);
console.log('resolved', Object.values(m).filter(x=>x.symbol).length, 'unresolved', none.length);
for (const i of none) console.log(' -', i.id, i.name, i.exchange ?? i.brokerSymbol, i.currency);
console.log(md.errors.slice(0, 15));
