import { loadSettings } from '../src/server/store.js';
import { computeSnapshot, state } from '../src/server/engine.js';
await computeSnapshot(loadSettings());
const s = state.snapshot!;
console.log(state.status, state.error ?? '', 'missing', s.performance.missingPrices);
console.log(s.instruments.filter(i => !i.hasMarket).map(i => [i.id, i.name, i.symbolNote]));
console.log(s.warnings);
