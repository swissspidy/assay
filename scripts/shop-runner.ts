/** Starts Tiny Shop and runs scripted scenarios in fresh browser contexts. */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { EvidenceRecorder, captureSnapshot, type EvidenceSnapshot } from '../src/index.ts';
import { shopProbes } from '../examples/tiny-shop/agent.ts';
import type { Scenario } from '../examples/tiny-shop/scenarios.ts';

export interface ShopRunner {
  baseURL: string;
  capture(scenario: Scenario): Promise<EvidenceSnapshot>;
  close(): Promise<void>;
}

async function waitFor(url: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Tiny Shop did not start at ${url}`);
}

export async function startShop(port = Number(process.env.TINY_SHOP_PORT ?? 4173)): Promise<ShopRunner> {
  const baseURL = `http://localhost:${port}`;
  let server: ChildProcess | undefined;
  try {
    await waitFor(`${baseURL}/api/products`, 200);
  } catch {
    const script = fileURLToPath(new URL('../examples/tiny-shop/server.mjs', import.meta.url));
    server = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    await waitFor(`${baseURL}/api/products`);
  }
  const browser: Browser = await chromium.launch();
  return {
    baseURL,
    async capture(scenario) {
      const context = await browser.newContext({ baseURL });
      try {
        await EvidenceRecorder.attach(context);
        const page = await context.newPage();
        await scenario.run(page);
        return await captureSnapshot(page, { probes: shopProbes(page) });
      } finally {
        await context.close();
      }
    },
    async close() {
      await browser.close();
      server?.kill();
    },
  };
}
