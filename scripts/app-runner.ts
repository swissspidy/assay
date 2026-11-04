/** Starts an example app at a given simulated release and runs scripted scenarios in fresh contexts. */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import type { EvidenceSnapshot } from '../src/index.ts';
import { EvidenceRecorder, captureSnapshot } from '../src/playwright/index.ts';
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
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Which app and version answers on a port, if any (see release() in examples/lib/kit.mjs). */
async function identify(baseURL: string): Promise<{ app: string; releases: number[] } | null> {
  try {
    const r = await fetch(`${baseURL}/__assay/version`, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
    return r.ok ? ((await r.json()) as { app: string; releases: number[] }) : null;
  } catch {
    return null;
  }
}

/**
 * Starts an app with the given releases applied (default: none, the app as
 * recorded). `slot` picks the port (app.port + 100 × slot) so variants never collide.
 */
export async function startApp(
  app: AppDef,
  opts: { releases?: number[]; slot?: number; port?: number } = {},
): Promise<AppRunner> {
  const releases = opts.releases ?? [];
  const port = opts.port ?? app.port + (opts.slot ?? 0) * 100;
  const baseURL = `http://localhost:${port}`;
  const label = `${app.name} [${releases.join(',') || 'as recorded'}]`;
  const same = (x: { app: string; releases: number[] } | null) =>
    x?.app === app.name && x.releases.join(',') === releases.join(',');
  let server: ChildProcess | undefined;
  const running = await identify(baseURL);
  if (running && !same(running)) {
    throw new Error(`${baseURL} serves ${running.app} [${running.releases.join(',')}], not ${label}`);
  }
  if (!running) {
    if (await waitFor(`${baseURL}/`, 200)) throw new Error(`${baseURL} is taken by something other than ${label}`);
    const script = fileURLToPath(new URL('server.mjs', app.dir));
    server = spawn(process.execPath, [script], {
      env: { ...process.env, PORT: String(port), APP_RELEASES: releases.join(',') },
      stdio: 'ignore',
    });
    if (!(await waitFor(`${baseURL}/`))) {
      server.kill();
      throw new Error(`${label} did not start at ${baseURL}`);
    }
    if (!same(await identify(baseURL))) {
      server.kill();
      throw new Error(`${baseURL} did not identify as ${label}`);
    }
  }
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    // No runner is returned, so nobody else could stop the server started here.
    server?.kill();
    throw e;
  }
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
      try {
        await browser.close();
      } finally {
        server?.kill();
      }
    },
  };
}
