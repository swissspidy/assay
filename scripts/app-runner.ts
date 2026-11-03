/** Starts an example app (optionally in its redesigned UI variant) and runs scripted scenarios in fresh contexts. */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { EvidenceRecorder, captureSnapshot, type EvidenceSnapshot } from '../src/index.ts';
import type { AppDef } from '../examples/apps.ts';
import type { Scenario } from '../examples/lib/scenario.ts';

export interface AppRunner {
  baseURL: string;
  capture(scenario: Scenario): Promise<EvidenceSnapshot>;
  close(): Promise<void>;
}

async function waitFor(url: string, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function startApp(
  app: AppDef,
  opts: { variant?: 'baseline' | 'redesign'; port?: number } = {},
): Promise<AppRunner> {
  const variant = opts.variant ?? 'baseline';
  // The redesign variant runs on its own port so it never collides with a baseline server.
  const port = opts.port ?? (variant === 'redesign' ? app.port + 100 : app.port);
  const baseURL = `http://localhost:${port}`;
  let server: ChildProcess | undefined;
  if (!(await waitFor(`${baseURL}/`, 200))) {
    const script = fileURLToPath(new URL('server.mjs', app.dir));
    server = spawn(process.execPath, [script], {
      env: { ...process.env, PORT: String(port), UI_VARIANT: variant },
      stdio: 'ignore',
    });
    if (!(await waitFor(`${baseURL}/`))) throw new Error(`${app.name} did not start at ${baseURL}`);
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
        return await captureSnapshot(page, { probes: app.probes(page) });
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
