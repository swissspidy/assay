import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.TINY_SHOP_PORT ?? 4173);
const server = (dir: string, port: number) => ({
  command: `node examples/${dir}/server.mjs`,
  env: { PORT: String(port) },
  url: `http://localhost:${port}/`,
  reuseExistingServer: !process.env.CI,
});

export default defineConfig({
  testDir: 'tests',
  // The packed-package test runs with node:test (npm run test:pack), not Playwright.
  testIgnore: ['pack/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Verification must be deterministic: no retries to hide flakiness.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: [server('tiny-shop', PORT), server('tiny-tracker', 4174), server('tiny-calendar', 4175)],
});
