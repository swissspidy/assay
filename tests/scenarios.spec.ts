/** Every scripted trajectory of every example app gets its labelled verdict from the handwritten checks (live and offline). */
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test } from '../src/playwright/index.ts';
import { captureBaseline, formatOutcome, type CheckSet } from '../src/index.ts';
import { APPS } from '../examples/apps.ts';
import { play } from '../examples/lib/scenario.ts';
import { judge } from './helpers.ts';

for (const app of APPS) {
  test.describe(app.name, () => {
    test.use({ baseURL: `http://localhost:${app.port}` });
    for (const task of app.tasks) {
      const checks = JSON.parse(readFileSync(new URL(`tasks/${task.id}.checks.json`, app.dir), 'utf8')) as CheckSet;
      for (const s of task.scenarios) {
        test(`${task.id} › ${s.name} (${s.kind}) → ${s.expected}`, async ({ page }) => {
          await play(s, page, (p) => captureBaseline(p, { probes: app.probes(p) }));
          const { outcome } = await judge(page, checks, { probes: app.probes(page) });
          expect(outcome.verdict, formatOutcome(outcome)).toBe(s.expected);
        });
      }
    }
  });
}
