/** Starts an example app at a given simulated release and runs scripted scenarios in fresh contexts. */
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

/** Which app and version answers on a port, if any (see release() in examples/lib/kit.mjs). */
async function identify(baseURL: string): Promise<{ app: string; version: number } | null> {
  try {
    const r = await fetch(`${baseURL}/__assay/version`, { redirect: 'manual' });
    return r.ok ? ((await r.json()) as { app: string; version: number }) : null;
  } catch {
    return null;
  }
}

export async function startApp(app: AppDef, opts: { version?: number; port?: number } = {}): Promise<AppRunner> {
  const version = opts.version ?? 1;
  // Each version gets its own port, so versions never collide.
  const port = opts.port ?? app.port + (version - 1) * 100;
  const baseURL = `http://localhost:${port}`;
  let server: ChildProcess | undefined;
  const running = await identify(baseURL);
  if (running && (running.app !== app.name || running.version !== version)) {
    throw new Error(`${baseURL} serves ${running.app} v${running.version}, not ${app.name} v${version}`);
  }
  if (!running) {
    if (await waitFor(`${baseURL}/`, 200)) throw new Error(`${baseURL} is taken by something other than ${app.name}`);
    const script = fileURLToPath(new URL('server.mjs', app.dir));
    server = spawn(process.execPath, [script], {
      env: { ...process.env, PORT: String(port), APP_VERSION: String(version) },
      stdio: 'ignore',
    });
    if (!(await waitFor(`${baseURL}/`))) throw new Error(`${app.name} did not start at ${baseURL}`);
    const started = await identify(baseURL);
    if (started?.app !== app.name || started.version !== version) {
      server.kill();
      throw new Error(`${baseURL} did not identify as ${app.name} v${version}`);
    }
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
