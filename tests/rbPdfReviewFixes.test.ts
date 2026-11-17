// Regression tests for the code review fixes of the RB PDF import (synthetic data only).
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { classifyFlows } from '../src/core/accounts/analytics.js';
import { readBankTables } from '../src/core/accounts/bankTables.js';
import { buildBankLedger } from '../src/core/accounts/ledger.js';
import { RbStatementFormatError, parseRbStatement } from '../src/core/accounts/rbPdf.js';
import { looksLikePdfStatements, readRbPdfTables } from '../src/core/accounts/rbPdfTables.js';
import type { BankTx } from '../src/core/accounts/types.js';
import { detectFileKind } from '../src/core/parsers/index.js';
import { RB_HEADER } from './bankFixtures.js';
import { rbStatementPdf } from './helpers/rbStatementPdf.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('stored statement summaries are bank files', () => {
  it('detectFileKind never reports statements.csv as an unknown (investment) file', () => {
    const text = '#myfin-bank,1,RB,1234567890,CZK,statements\nseq,from,to,opening,closing,income,expense,fees,txCount\n';
    expect(detectFileKind('banks/rb/1234567890/statements.csv', enc(text))).not.toBe('UNKNOWN');
  });
});

describe('zip detection', () => {
  it('a zip whose first entry is a folder is still recognised as PDF statements', async () => {
    const zip = new JSZip();
    zip.folder('vypisy');
    zip.file('vypisy/a.pdf', rbStatementPdf({ number: '1234567890', seq: 1, from: '2025-01-01', to: '2025-01-31', opening: 0, txs: [] }));
    const data = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    expect(looksLikePdfStatements('vypisy.zip', data)).toBe(true);
    const tables = await readRbPdfTables('vypisy.zip', data);
    expect(tables).toHaveLength(1);
  });
});

describe('RB statement that cannot be read completely', () => {
  it('a recognised RB statement without a period is a format error (retried), not "not a statement"', () => {
    const page = [
      { x: 417, y: 801, w: 80, s: 'Výpis z běžného účtu' },
      { x: 42, y: 722, w: 40, s: 'Číslo účtu:' },
      { x: 158, y: 722, w: 60, s: '1234567890/5500 CZK' },
      { x: 41, y: 37, w: 80, s: 'Raiffeisenbank a.s.' },
    ];
    expect(() => parseRbStatement([page])).toThrow(RbStatementFormatError);
  });
});

describe('RB CSV with a foreign currency sub-account', () => {
  it('rows of the same number in two currencies become two accounts', () => {
    const row = (id: string, cur: string, amount: string) =>
      `"10.01.2025";"10.01.2025";"1234567890/5500";"Test";"Platba";"";"";"Příchozí úhrada";"";"";"";"";"";"${amount}";"${cur}";"";"";"";"${id}";"";"";""`;
    const csv = [RB_HEADER.map((h) => `"${h}"`).join(';'), row('A1', 'CZK', '100,00'), row('A2', 'USD', '5,00')].join('\n');
    const tables = readBankTables('Pohyby.csv', enc(csv));
    expect(tables.map((t) => [t.unit, t.currency]).sort()).toEqual([
      ['banks/rb/1234567890', 'CZK'],
      ['banks/rb/1234567890_USD', 'USD'],
    ]);
  });
});

describe('exchange between an RB account and its sub-account', () => {
  const base = { bank: 'RB' as const, date: '2025-01-10', currency: 'CZK', bankType: 'Jednorázová úhrada' };
  it('is a transfer on both sides', () => {
    const czk: BankTx = { ...base, key: 'a', accountId: '1234567890/5500', amount: -2500, cpAccount: '1234567890/5500' };
    const usd: BankTx = { ...base, key: 'b', accountId: '1234567890/5500/USD', currency: 'USD', amount: 100, cpAccount: '1234567890/5500' };
    const flows = classifyFlows([czk, usd], ['1234567890/5500', '1234567890/5500/USD'], []);
    expect(flows.get('a')!.flow).toBe('transfer');
    expect(flows.get('b')!.flow).toBe('transfer');
  });
  it('a payment to the own number without a sub-account stays income/expense', () => {
    const t: BankTx = { ...base, key: 'c', accountId: '1234567890/5500', amount: -10, cpAccount: '1234567890/5500' };
    expect(classifyFlows([t], ['1234567890/5500'], []).get('c')!.flow).toBe('expense');
  });
});

describe('PDF movement without a transaction id', () => {
  it('is paired with the CSV movement of the same account, day and amount', () => {
    const csvRow = `"10.01.2025";"10.01.2025";"1234567890/5500";"Test";"Platba";"";"";"Příchozí úhrada";"";"";"";"";"";"100,00";"CZK";"";"";"";"X1";"";"";""`;
    const csv = { name: 'banks/rb/1234567890/2025/transactions.csv', data: enc([`#myfin-bank,1,RB,1234567890,CZK`, RB_HEADER.join(','), csvRow.replace(/"/g, '').replace(/;/g, ',')].join('\n')) };
    const pdfStored = {
      name: 'banks/rb/1234567890/2025/statement-transactions.csv',
      data: enc(
        [
          '#myfin-bank,1,RB,1234567890,CZK,pdf',
          'Datum zaúčtování,Datum provedení,Id transakce,Kategorie transakce,Číslo protiúčtu,Název protiúčtu,Typ transakce,Zpráva,Poznámka,VS,KS,SS,Poplatky,Zaúčtovaná částka,Měna účtu,Původní částka,Původní měna,Kurz,Název obchodníka,Město,Země',
          '10.01.2025,,,Platba,,,Příchozí úhrada,,,,,,,100,CZK,,,,OBCHOD,PRAHA,CZE',
        ].join('\n'),
      ),
    };
    for (const files of [
      [csv, pdfStored],
      [pdfStored, csv],
    ]) {
      const l = buildBankLedger(files);
      expect(l.txs).toHaveLength(1);
      expect(l.txs[0]).toMatchObject({ source: 'both', amount: 100, merchant: 'OBCHOD', city: 'PRAHA' });
    }
  });
});
