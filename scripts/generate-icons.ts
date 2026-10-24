/**
 * Rasterises src/web/public/logo.svg into the PNG icons used by the browser, Electron and electron-builder.
 * Usage: npm run icons   (needs the Playwright Chromium: npx playwright install chromium)
 */
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'src/web/public/logo.svg'), 'utf8');

const targets: [string, number][] = [
  ['build/icon.png', 1024], // electron-builder derives .ico / .icns from it
  ['src/web/public/icon-256.png', 256], // Electron window icon
  ['src/web/public/apple-touch-icon.png', 180],
  ['src/web/public/favicon-32.png', 32],
];

const browser = await chromium.launch();
try {
  for (const [file, size] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
    await mkdir(dirname(join(root, file)), { recursive: true });
    await page.screenshot({ path: join(root, file), omitBackground: true });
    await page.close();
    console.log(`${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
