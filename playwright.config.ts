import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.TINY_SHOP_PORT ?? 4173);

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Verification must be deterministic: no retries to hide flakiness.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: `node examples/tiny-shop/server.mjs`,
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/api/products`,
    reuseExistingServer: !process.env.CI,
  },
});
