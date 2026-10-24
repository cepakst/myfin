import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 5199);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tests/e2e/serve.mjs',
    url: `http://127.0.0.1:${port}/api/status`,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
