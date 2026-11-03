/**
 * Runs every Tiny Shop scenario and stores its evidence snapshot:
 *   examples/tiny-shop/references/<task>/<scenario>.json
 * These are the compiler's reference runs (M2) and stress-test seeds (M3).
 *
 *   node scripts/capture-references.ts [taskId...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { TASKS } from '../examples/tiny-shop/scenarios.ts';
import { startShop } from './shop-runner.ts';
import type { EvidenceSnapshot } from '../src/index.ts';

const incomplete = (s: EvidenceSnapshot) => (s.network ?? []).some((e) => e.bodyUnavailable || e.bodyTruncated);

const only = new Set(process.argv.slice(2));
const shop = await startShop();
try {
  for (const task of TASKS) {
    if (only.size && !only.has(task.id)) continue;
    const dir = new URL(`../examples/tiny-shop/references/${task.id}/`, import.meta.url);
    mkdirSync(dir, { recursive: true });
    for (const s of task.scenarios) {
      // A reference must be complete: an unreadable body would become compiler input.
      let snap = await shop.capture(s);
      for (let attempt = 1; incomplete(snap) && attempt < 3; attempt++) snap = await shop.capture(s);
      if (incomplete(snap)) throw new Error(`${task.id}/${s.name}: response bodies could not be captured`);
      // capturedAt is metadata (excluded from digests); pin it so re-captures diff cleanly.
      snap.capturedAt = '1970-01-01T00:00:00.000Z';
      const file = new URL(`${s.name}.json`, dir);
      writeFileSync(
        file,
        JSON.stringify({ label: { expected: s.expected, kind: s.kind }, snapshot: snap }, null, 1) + '\n',
      );
      console.warn(`${task.id}/${s.name} (${s.expected})`);
    }
  }
} finally {
  await shop.close();
}
