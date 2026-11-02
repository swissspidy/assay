import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.TINY_SHOP_PORT ?? 4173);

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  reporter: process.env.CI ? 'list' : [['list']],
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `node examples/tiny-shop/server.mjs`,
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/api/products`,
    reuseExistingServer: !process.env.CI,
  },
});
