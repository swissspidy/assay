/** `assay capture <url>`: open a URL in headless Chromium and capture an evidence snapshot. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrowserType } from '@playwright/test';
import { CliError, EXIT, UsageError, readCheckSetFile, type Invocation, type Io } from '../io.ts';
import { cliConfig } from '../config.ts';

/** The part of Playwright that capture uses. */
interface PlaywrightTest {
  chromium: BrowserType;
}

const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle'] as const;

/** Load Playwright (an optional peer for the CLI); a missing install becomes a clear error. */
export async function loadPlaywright(
  importer: () => Promise<PlaywrightTest> = () => import('@playwright/test'),
): Promise<PlaywrightTest> {
  try {
    return await importer();
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new CliError(
        'assay capture needs Playwright: npm install -D @playwright/test, then npx playwright install chromium',
      );
    }
    throw e;
  }
}

/**
 * Where the snapshot goes: a `--out` path ending in `.json` as is, else a file in that directory.
 * With `directory` (the config's `snapshots`), the path is always a directory.
 */
export function outFile(out: string, url: URL, now = new Date(), opts: { directory?: boolean } = {}): string {
  if (out.endsWith('.json') && !opts.directory) return out;
  const host = (url.host || 'page').replace(/[^\w.-]+/g, '_');
  return join(out, `${host}-${now.toISOString().replace(/[:.]/g, '-')}.json`);
}

/**
 * Write the snapshot where `--out` says. A named `.json` file is replaced; a file the command
 * names in a directory is created exclusively, so a capture in the same millisecond gets a
 * suffixed name (`-2`, `-3`, …) instead of overwriting another one.
 */
export function writeSnapshot(
  out: string,
  url: URL,
  json: string,
  now = new Date(),
  opts: { directory?: boolean } = {},
): string {
  const file = outFile(out, url, now, opts);
  mkdirSync(dirname(file), { recursive: true });
  if (out.endsWith('.json') && !opts.directory) {
    writeFileSync(file, json);
    return file;
  }
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? file : file.replace(/\.json$/, `-${n}.json`);
    try {
      writeFileSync(candidate, json, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  let url: URL;
  try {
    url = new URL(positionals[0]!);
  } catch {
    throw new UsageError(`not a URL: ${positionals[0]}`);
  }
  const waitUntil = (values['wait-until'] as string | undefined) ?? 'load';
  if (!(WAIT_UNTIL as readonly string[]).includes(waitUntil)) {
    throw new UsageError(`--wait-until must be one of ${WAIT_UNTIL.join(', ')}`);
  }
  const wait = values.wait === undefined ? 0 : Number(values.wait);
  if (!Number.isFinite(wait) || wait < 0) throw new UsageError('--wait must be a number of milliseconds');

  // Where the snapshot goes, decided before Chromium starts: a bad config must not cost a capture.
  const flagOut = values.out as string | undefined;
  const out = flagOut ?? (await cliConfig(values, io)).config.snapshots;
  // A scoped capture (ADR 0025) records only what the check set reads; it is read first, so a bad set costs no browser.
  const scope = typeof values.scope === 'string' ? await readCheckSetFile(values.scope) : undefined;
  if (scope !== undefined) {
    const { scopePlan } = await import('../../snapshot/scope.ts');
    try {
      scopePlan(scope);
    } catch (e) {
      throw new CliError(`${values.scope as string}: ${(e as Error).message}`);
    }
  }
  const { chromium } = await loadPlaywright();
  const { EvidenceRecorder, captureScopedSnapshot, captureSnapshot } = await import('../../snapshot/capture.ts');
  const exe = values['executable-path'] as string | undefined;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  let snapshot;
  try {
    const context = await browser.newContext();
    // Attached before navigating, so the log holds every request the page makes.
    await EvidenceRecorder.attach(context, values.trajectory === true ? { trajectory: true } : {});
    const page = await context.newPage();
    const response = await page.goto(url.href, { waitUntil: waitUntil as (typeof WAIT_UNTIL)[number] });
    if (wait) await page.waitForTimeout(wait);
    // Written to a file and never verified here: no digest to take at capture time.
    const opts = values.storage === false ? { storage: false } : {};
    snapshot = scope
      ? await captureScopedSnapshot(page, scope, opts)
      : await captureSnapshot(page, { digest: false, ...opts });
    if (response && !response.ok()) io.err(`warning: ${url.href} answered ${response.status()}`);
  } finally {
    await browser.close();
  }

  const json = JSON.stringify(snapshot, null, 2) + '\n';
  if (!out) {
    io.out(json.trimEnd());
    return EXIT.ok;
  }
  // The config's `snapshots` is a directory even when its name ends in .json.
  const file = writeSnapshot(out, url, json, new Date(), { directory: flagOut === undefined });
  io.out(values.json ? JSON.stringify({ file }) : `Wrote ${file}`);
  return EXIT.ok;
}
