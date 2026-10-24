import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { selectYear, trackErrors, waitForSnapshot } from './helpers';

test.describe('tax report Excel', () => {
  test('downloads a workbook explaining the selected year', async ({ page }) => {
    const { errors, foreignRequests } = trackErrors(page);
    await waitForSnapshot(page);
    await page.goto('/#/dane');
    await selectYear(page, 2024);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tax-report').click()]);
    expect(download.suggestedFilename()).toBe('myfin-dane-2024.xlsx');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await readFile((await download.path())!)) as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(['Souhrn', 'Prodeje CP', 'Dividendy', 'Kurzy', 'DAP']));
    const sum = wb.getWorksheet('Souhrn')!;
    const labels: string[] = [];
    sum.eachRow((r) => labels.push(String(r.getCell(1).value ?? '')));
    expect(labels.some((l) => l.startsWith('ř. 209 '))).toBe(true);

    expect(errors).toEqual([]);
    expect(foreignRequests).toEqual([]);
  });

  test('rejects unknown years', async ({ page }) => {
    await waitForSnapshot(page);
    expect((await page.request.get('/api/tax-report/1999')).status()).toBe(404);
    expect((await page.request.get('/api/tax-report/abc')).status()).toBe(404);
  });
});
