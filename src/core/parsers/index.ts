import { emptyLedger, type Ledger } from '../types.js';
import { parseDegiroAccount, parseDegiroTransactions } from './degiro.js';
import { loadXtbWorkbook, parseXtbXlsx } from './xtb.js';

export interface InputFile {
  name: string;
  data: Uint8Array;
}

type Kind = 'DEGIRO_TX' | 'DEGIRO_ACCOUNT' | 'XTB' | 'UNKNOWN';

export function detectFileKind(name: string, data: Uint8Array): Kind {
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip') || lower.endsWith('.xlsx')) return 'XTB';
  if (lower.endsWith('.csv')) {
    const head = new TextDecoder('utf-8').decode(data.slice(0, 600)).split(/\r?\n/)[0] ?? '';
    if (/Venue|Reference exchange|Order ID/i.test(head) && /Quantity|Počet/i.test(head)) return 'DEGIRO_TX';
    if (/Description|Popis|Omschrijving/i.test(head) && /Balance|Zůstatek|Saldo/i.test(head)) return 'DEGIRO_ACCOUNT';
  }
  return 'UNKNOWN';
}

export async function buildLedger(files: InputFile[]): Promise<Ledger> {
  const ledger = emptyLedger();
  const kinds = files.map((f) => ({ f, kind: detectFileKind(f.name, f.data) }));
  const order: Kind[] = ['DEGIRO_TX', 'DEGIRO_ACCOUNT', 'XTB'];
  for (const k of order) {
    for (const { f, kind } of kinds) {
      if (kind !== k) continue;
      try {
        if (kind === 'DEGIRO_TX') parseDegiroTransactions(new TextDecoder('utf-8').decode(f.data), ledger, f.name);
        else if (kind === 'DEGIRO_ACCOUNT') parseDegiroAccount(new TextDecoder('utf-8').decode(f.data), ledger, f.name);
        else {
          for (const wb of await loadXtbWorkbook(f.data, f.name)) await parseXtbXlsx(wb.data, ledger, `${f.name}/${wb.name}`);
        }
      } catch (e) {
        ledger.warnings.push({ source: f.name, message: `Chyba při načítání: ${(e as Error).message}` });
      }
    }
  }
  for (const { f, kind } of kinds) {
    if (kind === 'UNKNOWN') ledger.warnings.push({ source: f.name, message: 'Neznámý formát souboru – přeskočeno.' });
  }
  ledger.trades.sort((a, b) => (a.dateTime === b.dateTime ? b.quantity - a.quantity : a.dateTime < b.dateTime ? -1 : 1));
  ledger.actions.sort((a, b) => (a.dateTime < b.dateTime ? -1 : a.dateTime > b.dateTime ? 1 : 0));
  ledger.cash.sort((a, b) => (a.dateTime < b.dateTime ? -1 : a.dateTime > b.dateTime ? 1 : 0));
  return ledger;
}
