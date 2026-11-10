/**
 * Captures the Tiny Pharmacy references (ADR 0024): one run per order, with the trajectory.
 *
 *   node examples/refill/capture.ts [--executable-path /path/to/chromium]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { EvidenceRecorder, captureSnapshot } from '../../src/playwright/index.ts';
import { RUNS, refillProbes, runRefill, startRefillApp } from './app.ts';

const { values } = parseArgs({ options: { 'executable-path': { type: 'string' } } });
const exe = values['executable-path'];
mkdirSync(new URL('references/', import.meta.url), { recursive: true });
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
try {
  for (const run of RUNS) {
    // A fixed port, so re-captures differ only in what the run did.
    const app = await startRefillApp(4176);
    try {
      const context = await browser.newContext();
      await EvidenceRecorder.attach(context, { trajectory: true });
      const page = await context.newPage();
      await runRefill(page, app.origin, run.order);
      const snapshot = await captureSnapshot(page, { probes: refillProbes(app), digest: false });
      await context.close();
      // capturedAt is metadata (excluded from digests); pinned so re-captures diff cleanly.
      const pinned = { ...snapshot, capturedAt: '1970-01-01T00:00:00.000Z' };
      writeFileSync(
        new URL(`references/${run.name}.json`, import.meta.url),
        JSON.stringify({ label: { expected: run.expected, order: run.order }, snapshot: pinned }, null, 1) + '\n',
      );
      console.warn(`${run.name} (${run.expected})`);
    } finally {
      await app.close();
    }
  }
} finally {
  await browser.close();
}
