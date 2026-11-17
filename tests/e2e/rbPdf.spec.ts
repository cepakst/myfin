import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rbStatementPdf, type SyntheticStatement, type SyntheticTx } from '../helpers/rbStatementPdf.js';
import { trackErrors, waitForSnapshot } from './helpers.js';

// Raiffeisenbank PDF statements, generated at test time (no PDF fixtures in the repository) for a
// fictitious account 9990001112. They are uploaded through the Settings dropzone into the isolated
// e2e store; afterAll removes everything this spec added, so the other specs see the fixtures only.
//   Jan: opening 1 000, +500, card -200 with fee -5   -> 1 295
//   Feb: no movements                                  -> 1 295
//   Mar: +300                                          -> 1 595
const ACC = '9990001112';
const ID = `${ACC}/5500`;
const DATA_DIR = join(tmpdir(), 'myfin-e2e');
const STORE = join(DATA_DIR, 'store');

const nf = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
const kc = (n: number) => `${nf.format(Math.round(n))} Kč`.replace(/\s/g, ' ');

const tx = (date: string, code: string, amount: number, extra: Partial<SyntheticTx> = {}): SyntheticTx => ({
  date,
  valueDate: date,
  code,
  category: 'Platba',
  type: amount > 0 ? 'Příchozí úhrada' : 'Odchozí úhrada',
  amount,
  cpName: 'PARTNER',
  ...extra,
});
const st = (over: Partial<SyntheticStatement> & Pick<SyntheticStatement, 'seq' | 'from' | 'to' | 'opening'>): SyntheticStatement => ({ number: ACC, txs: [], ...over });
const JAN = st({
  seq: 1,
  from: '2025-01-01',
  to: '2025-01-31',
  opening: 1000,
  txs: [tx('2025-01-05', '9000001', 500, { cpName: 'ZAMESTNAVATEL' }), tx('2025-01-20', '9000002', -200, { category: 'Nákupy', type: 'Platba kartou', fee: -5, card: { merchant: 'KAVARNA', city: 'BRNO', country: 'CZE' } })],
});
const FEB = st({ seq: 2, from: '2025-02-01', to: '2025-02-28', opening: 1295 });
const MAR = st({ seq: 3, from: '2025-03-01', to: '2025-03-31', opening: 1295, txs: [tx('2025-03-05', '9000003', 300)] });

async function zipBuffer(): Promise<Buffer> {
  const z = new JSZip();
  z.file('vypis_01.pdf', rbStatementPdf(JAN));
  z.file('vypis_02.pdf', rbStatementPdf(FEB));
  z.file('vypis_03.pdf', rbStatementPdf(MAR));
  return z.generateAsync({ type: 'nodebuffer' });
}

const q = (v: string) => `"${v}"`;
/** RB CSV export: the January card payment (with fee, no merchant) and a February movement no statement has */
function csvBuffer(): Buffer {
  const header = ['Datum provedení', 'Datum zaúčtování', 'Číslo účtu', 'Název účtu', 'Kategorie transakce', 'Číslo protiúčtu', 'Název protiúčtu', 'Typ transakce', 'Zpráva', 'Poznámka', 'VS', 'KS', 'SS', 'Zaúčtovaná částka', 'Měna účtu', 'Původní částka', 'Původní měna', 'Poplatky', 'Id transakce', 'Vlastní poznámka', 'Název obchodníka', 'Město'];
  const line = (date: string, amount: string, fee: string, type: string, id: string) =>
    header.map((h) => q(({ 'Datum provedení': date, 'Datum zaúčtování': date, 'Číslo účtu': `${ACC}/5500`, 'Název účtu': 'Testovaci RB PDF', 'Typ transakce': type, 'Zaúčtovaná částka': amount, 'Měna účtu': 'CZK', Poplatky: fee, 'Id transakce': id } as Record<string, string>)[h] ?? '')).join(';');
  const lines = [header.map(q).join(';'), line('20.01.2025', '-200,00', '-5,00', 'Platba kartou', '9000002'), line('10.02.2025', '-40,00', '', 'Odchozí úhrada', '9000009')];
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf-8');
}

type Acc = { id: string; displayName: string; balance: number; anchored: boolean; txCount: number };
type Snap = { accounts: Acc[]; txs: { accountId: string; date: string; amount: number }[]; warnings: { source: string; message: string }[] };
async function accounts(page: Page): Promise<Snap> {
  await waitForSnapshot(page);
  const r = await page.request.get('/api/accounts');
  expect(r.status()).toBe(200);
  return r.json();
}

/** A new, non-conflicting export is imported right away (the dialog only appears on a conflict). */
async function drop(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByTestId('import-dropzone').locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
  await expect(page.getByText(new RegExp(`${name.replace('.', '\.')} importován`)).first()).toBeVisible({ timeout: 30_000 });
}

function cleanStore() {
  for (const p of [`banks/rb/${ACC}`]) rmSync(join(STORE, ...p.split('/')), { recursive: true, force: true });
  const cov = join(STORE, 'myfin-coverage.json');
  if (existsSync(cov)) {
    const j = JSON.parse(readFileSync(cov, 'utf-8'));
    const units = j.units ?? j;
    for (const k of Object.keys(units)) if (k.startsWith(`banks/rb/${ACC}`)) delete units[k];
    writeFileSync(cov, JSON.stringify(j, null, 2));
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('Raiffeisenbank PDF statements', () => {
  test.beforeAll(cleanStore);
  test.afterAll(async ({ request }) => {
    cleanStore();
    await request.post('/api/reload', { data: {} });
    await expect
      .poll(async () => (await (await request.get('/api/status')).json()).status, { timeout: 45_000 })
      .toMatch(/ready|error/);
  });

  test('PDF statements alone: the balance is verified (not an estimate) and the PDF unit is listed in storage', async ({ page }) => {
    const { errors, foreignRequests } = trackErrors(page);
    await waitForSnapshot(page);
    await page.goto('/#/nastaveni');
    await drop(page, 'vypisy.zip', 'application/zip', await zipBuffer());

    const storage = page.getByTestId('storage');
    await expect(storage).toContainText('PDF výpisy', { timeout: 30_000 });
    await expect(storage).toContainText(ACC);
    await expect(storage).toContainText('1. 1. 2025 – 31. 3. 2025');

    const s = await accounts(page);
    const acc = s.accounts.find((a) => a.id === ID)!;
    expect(acc).toBeTruthy();
    expect(acc.anchored).toBe(true);
    expect(acc.balance).toBe(1595);
    // J1, card payment, its fee as a movement of its own, M1
    expect(acc.txCount).toBe(4);
    expect(s.warnings.filter((w) => w.source === ID)).toEqual([]);

    await page.goto('/#/ucty');
    const row = page.getByTestId('accounts-table').locator('tbody tr').filter({ hasText: ID });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(kc(1595));
    await expect(row.getByText('odhad', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });

  test('re-uploading the same zip changes nothing', async ({ page }) => {
    await waitForSnapshot(page);
    const before = (await accounts(page)).accounts.find((a) => a.id === ID)!;
    const prev = await page.request.post('/api/import/preview', { multipart: { file: { name: 'vypisy.zip', mimeType: 'application/zip', buffer: await zipBuffer() } } });
    expect(prev.ok()).toBe(true);
    const body = await prev.json();
    expect(body.units[0].plan).toMatchObject({ added: 0, removed: 0, unchanged: true });
    await page.request.post('/api/import/cancel', { data: { id: body.id } });
    const after = (await accounts(page)).accounts.find((a) => a.id === ID)!;
    expect(after).toEqual(before);
  });

  test('CSV export together with the PDF statements does not double the movements', async ({ page }) => {
    await waitForSnapshot(page);
    await page.goto('/#/nastaveni');
    await drop(page, 'pohyby.csv', 'text/csv', csvBuffer());
    await waitForSnapshot(page);
    const s = await accounts(page);
    const mine = s.txs.filter((t) => t.accountId === ID);
    // the PDF movements (4) plus the one February movement only the CSV has
    expect(mine).toHaveLength(5);
    expect(mine.filter((t) => t.date === '2025-01-20').map((t) => t.amount).sort((a, b) => a - b)).toEqual([-200, -5]);
    expect(mine.filter((t) => t.date === '2025-02-10').map((t) => t.amount)).toEqual([-40]);
    const acc = s.accounts.find((a) => a.id === ID)!;
    expect(acc.txCount).toBe(5);
    expect(acc.anchored).toBe(true);
    expect(s.warnings.filter((w) => w.source === ID && /liší/.test(w.message))).toEqual([]);

    await page.goto('/#/ucty');
    const row = page.getByTestId('accounts-table').locator('tbody tr').filter({ hasText: ID });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText('odhad', { exact: true })).toHaveCount(0);
    await page.goto('/#/nastaveni');
    await expect(page.getByTestId('storage')).toContainText('PDF výpisy');
    await expect(page.getByTestId('storage')).toContainText(`účet ${ACC} (CZK)`);
  });
});
