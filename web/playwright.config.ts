import { defineConfig, devices } from '@playwright/test';
import { loadEnv } from 'vite';

const base = loadEnv('pages', process.cwd(), '').VITE_BASE_PATH || '/';
const origin = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `${origin}${base}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview -- --mode pages --host 127.0.0.1 --port 4173 --strictPort',
    url: `${origin}${base}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
