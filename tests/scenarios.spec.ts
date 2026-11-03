/** Every scripted Tiny Shop trajectory gets its labelled verdict from the handwritten checks. */
import { expect } from '@playwright/test';
import { test } from '../src/playwright/index.ts';
import { formatOutcome } from '../src/index.ts';
import { TASKS } from '../examples/tiny-shop/scenarios.ts';
import { judge, loadChecks, shopProbes } from './helpers.ts';

for (const task of TASKS) {
  test.describe(task.id, () => {
    const checks = loadChecks(task.id);
    for (const s of task.scenarios) {
      test(`${s.name} (${s.kind}) → ${s.expected}`, async ({ page }) => {
        await s.run(page);
        const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
        expect(outcome.verdict, formatOutcome(outcome)).toBe(s.expected);
      });
    }
  });
}
