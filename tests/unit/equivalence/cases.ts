/**
 * The cases of the evaluator equivalence test (ADR 0015): every committed snapshot (the
 * example apps' references and the real-app runs) with the check sets of its app, and the
 * stress tests of every committed check set. `golden.json.gz` holds what the evaluator
 * before the evidence store and compiled plans returned for each of them (generate.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { CheckSet, EvidenceSnapshot } from '../../../src/types.ts';
import { APPS } from '../../../examples/apps.ts';
import { compiledFile, isTrainingRun, realApps, realRuns, realTasks } from '../../../eval/real/dataset.ts';

export interface VerifyCase {
  id: string;
  /** The snapshot was captured for this check set's task: its full result is kept, not only a digest. */
  own: boolean;
  checkSet: CheckSet;
  snapshot: EvidenceSnapshot;
}

export interface StressCase {
  id: string;
  checkSet: CheckSet;
  refs: { name: string; snapshot: EvidenceSnapshot }[];
  skipVariants: string[];
}

const readJson = <T>(u: URL): T => JSON.parse(readFileSync(u, 'utf8')) as T;

export function collectCases(): { verify: VerifyCase[]; stress: StressCase[] } {
  const verify: VerifyCase[] = [];
  const stress: StressCase[] = [];
  for (const app of APPS) {
    const snaps: { task: string; name: string; label: string; snapshot: EvidenceSnapshot }[] = [];
    const sets: { task: string; kind: string; checkSet: CheckSet; skipVariants: string[] }[] = [];
    for (const def of app.tasks) {
      const refDir = new URL(`references/${def.id}/`, app.dir);
      if (existsSync(refDir))
        for (const f of readdirSync(refDir).toSorted()) {
          const r = readJson<{ snapshot: EvidenceSnapshot; label: { expected: string } }>(new URL(f, refDir));
          snaps.push({ task: def.id, name: f.replace(/\.json$/, ''), label: r.label.expected, snapshot: r.snapshot });
        }
      for (const kind of ['tasks', 'compiled']) {
        const f = new URL(`${kind}/${def.id}.checks.json`, app.dir);
        if (existsSync(f))
          sets.push({ task: def.id, kind, checkSet: readJson<CheckSet>(f), skipVariants: def.skipVariants ?? [] });
      }
    }
    for (const s of sets) {
      for (const r of snaps)
        verify.push({
          id: `${app.name}/${s.kind}/${s.task} @ ${r.task}/${r.name}`,
          own: r.task === s.task,
          checkSet: s.checkSet,
          snapshot: r.snapshot,
        });
      stress.push({
        id: `${app.name}/${s.kind}/${s.task}`,
        checkSet: s.checkSet,
        refs: snaps
          .filter((r) => r.task === s.task && r.label === 'success')
          .map((r) => ({ name: r.name, snapshot: r.snapshot })),
        skipVariants: s.skipVariants,
      });
    }
  }
  for (const app of realApps()) {
    const runs = realTasks(app).flatMap((task) => realRuns(app, task));
    for (const task of realTasks(app)) {
      const f = compiledFile(app, task, 'checks');
      if (!existsSync(f)) continue;
      const checkSet = readJson<CheckSet>(f);
      for (const r of runs)
        verify.push({
          id: `real/${app}/${task} @ ${r.task}/${r.name}`,
          own: r.task === task,
          checkSet,
          snapshot: r.snapshot,
        });
      stress.push({
        id: `real/${app}/${task}`,
        checkSet,
        refs: runs
          .filter((r) => r.task === task && isTrainingRun(r.name))
          .map((r) => ({ name: r.name, snapshot: r.snapshot })),
        skipVariants: [],
      });
    }
  }
  return { verify, stress };
}

/** What `verify` returned, without what differs on every run: the record's id, time and timings. */
export function normalize(result: { outcome: unknown; checksOutcome: unknown; record: object }): unknown {
  const { id: _id, createdAt: _at, timings: _t, ...record } = result.record as Record<string, unknown>;
  return { outcome: result.outcome, checksOutcome: result.checksOutcome, record };
}

export const digest = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export const GOLDEN = new URL('./golden.json.gz', import.meta.url);

export interface Golden {
  /** The commit whose evaluator produced it. */
  commit: string;
  /** Case id → JSON of the normalized result (own cases) or its digest (others). */
  verify: Record<string, { json?: string; digest: string }>;
  /** Case id → digest of the stress report's JSON. */
  stress: Record<string, string>;
}
