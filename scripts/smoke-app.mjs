// Smoke test for a packaged app: launches the executable with an isolated temp data dir and
// waits until the embedded server answers /api/status. Used by the release workflow.
// Usage: node scripts/smoke-app.mjs <path to app executable>
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2];
if (!exe) {
  console.error('usage: node scripts/smoke-app.mjs <path to app executable>');
  process.exit(2);
}

const port = 5198;
const dir = mkdtempSync(join(tmpdir(), 'myfin-smoke-'));
const env = {
  ...process.env,
  MYFIN_PORT: String(port),
  MYFIN_ROOT: dir,
  MYFIN_DATA: join(dir, 'data'),
  MYFIN_EXPORTS: join(dir, 'exports'),
};

const child = spawn(exe, [], { env, stdio: 'inherit' });
let exitCode = null;
child.on('exit', (code) => (exitCode = code ?? -1));
child.on('error', (e) => {
  console.error(`Failed to launch ${exe}: ${e.message}`);
  exitCode = -1;
});

let ok = false;
const deadline = Date.now() + 90_000;
while (!ok && exitCode === null && Date.now() < deadline) {
  try {
    ok = (await fetch(`http://127.0.0.1:${port}/api/status`)).ok;
  } catch {
    // server not up yet
  }
  if (!ok) await new Promise((r) => setTimeout(r, 1000));
}

child.kill();
await new Promise((r) => setTimeout(r, 2000));
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // files may still be locked on Windows; the temp dir is disposable
}

if (ok) {
  console.log(`Smoke test passed: ${exe} served /api/status on port ${port}.`);
  process.exit(0);
}
console.error(exitCode !== null ? `App exited early (code ${exitCode}).` : 'App did not answer within 90 s.');
process.exit(1);
