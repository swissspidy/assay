/**
 * Runs every scenario of every example app and stores its evidence snapshot:
 *   examples/<app>/references/<task>/<scenario>.json
 * These are the compiler's reference runs (M2), stress-test seeds (M3) and the
 * evaluation dataset (M5).
 *
 *   node scripts/capture-references.ts [app] [taskId...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { EvidenceSnapshot } from '../src/index.ts';
import { APPS } from '../examples/apps.ts';
import { startApp } from './app-runner.ts';

const [onlyApp, ...onlyTasks] = process.argv.slice(2);
const incomplete = (s: EvidenceSnapshot) => (s.network ?? []).some((e) => e.bodyUnavailable || e.bodyTruncated);

for (const app of APPS) {
  if (onlyApp && app.name !== onlyApp) continue;
  const runner = await startApp(app);
  try {
    for (const task of app.tasks) {
      if (onlyTasks.length && !onlyTasks.includes(task.id)) continue;
      const dir = new URL(`references/${task.id}/`, app.dir);
      mkdirSync(dir, { recursive: true });
      for (const s of task.scenarios) {
        // A reference must be complete: an unreadable body would become compiler input.
        let snap = await runner.capture(s);
        for (let attempt = 1; incomplete(snap) && attempt < 3; attempt++) snap = await runner.capture(s);
        if (incomplete(snap))
          throw new Error(`${app.name}/${task.id}/${s.name}: response bodies could not be captured`);
        // capturedAt is metadata (excluded from digests); pin it so re-captures diff cleanly.
        snap.capturedAt = '1970-01-01T00:00:00.000Z';
        writeFileSync(
          new URL(`${s.name}.json`, dir),
          JSON.stringify({ label: { expected: s.expected, kind: s.kind }, snapshot: snap }, null, 1) + '\n',
        );
        console.warn(`${app.name}/${task.id}/${s.name} (${s.expected})`);
      }
    }
  } finally {
    await runner.close();
  }
}
