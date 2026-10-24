// Starts the built server for Playwright with an isolated data dir and synthetic exports only.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dataDir = join(tmpdir(), 'myfin-e2e');
rmSync(dataDir, { recursive: true, force: true });
process.env.MYFIN_DATA = dataDir;
process.env.MYFIN_EXPORTS = resolve('tests/e2e/fixtures');
process.env.PORT = process.env.E2E_PORT ?? '5199';

await import(pathToFileURL(resolve('dist/server/main.js')).href);
