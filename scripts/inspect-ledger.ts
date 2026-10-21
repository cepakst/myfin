import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildLedger } from '../src/core/parsers/index.js';
import { runFifo } from '../src/core/fifo.js';
function walk(d: string): string[] { return readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }); }
const l = await buildLedger(walk('exports').map(p => ({ name: p, data: new Uint8Array(readFileSync(p)) })));
const r = runFifo(l, (a) => a * 25);
const top = [...r.realizations].sort((a,b)=>b.holdingDays-a.holdingDays).slice(0,5);
console.log(top.map(x => [x.acqDate, x.sellDate, x.holdingDays, x.timeTestDate, x.timeTestPassed]));
const open = r.openLots.filter(x => x.timeTestDate <= '2026-10-21');
console.log('open lots already time-tested', open.length, open.slice(0,3).map(x=>[x.acqDate,x.timeTestDate]));
