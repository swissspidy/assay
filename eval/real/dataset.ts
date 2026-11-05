/**
 * Reads the stored real-app runs (eval/real/runs/<app>/<task>/<run>.json.gz) and
 * compiled check sets (eval/real/compiled/<app>/<task>.checks.json) without
 * starting any app, so the evaluation replays in CI from files alone.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { RunFile } from './lib/types.ts';

export const REAL_ROOT = new URL('./', import.meta.url);
/** The run each task is compiled from; it is never scored. */
export const TRAINING_RUN = 'reference';
/** Further correct references through another route (`reference-<name>`, ADR 0011); never scored either. */
export const isTrainingRun = (name: string): boolean => name === TRAINING_RUN || name.startsWith(`${TRAINING_RUN}-`);

export interface StoredRun extends RunFile {
  app: string;
  task: string;
  name: string;
}

export const realApps = (): string[] =>
  existsSync(new URL('runs/', REAL_ROOT))
    ? readdirSync(new URL('runs/', REAL_ROOT))
        .filter((d) => !d.startsWith('.'))
        .toSorted()
    : [];

export const realTasks = (app: string): string[] =>
  readdirSync(new URL(`runs/${app}/`, REAL_ROOT))
    .filter((d) => !d.startsWith('.'))
    .toSorted();

export function readRun(app: string, task: string, name: string): StoredRun {
  const file = new URL(`runs/${app}/${task}/${name}.json.gz`, REAL_ROOT);
  return { app, task, name, ...(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as RunFile) };
}

export function realRuns(app: string, task: string): StoredRun[] {
  return readdirSync(new URL(`runs/${app}/${task}/`, REAL_ROOT))
    .filter((f) => f.endsWith('.json.gz'))
    .toSorted()
    .map((f) => readRun(app, task, f.replace(/\.json\.gz$/, '')));
}

export const compiledFile = (app: string, task: string, ext: 'checks' | 'report' | 'cassette') =>
  new URL(`compiled/${app}/${task}.${ext}.json`, REAL_ROOT);

/** Run kind for reports: where the run came from and, for agent runs, how it ended. */
export function runKind(r: RunFile): string {
  if (r.source.type === 'agent') return r.label.expected === 'success' ? 'agent: correct' : 'agent: incorrect';
  if (r.source.type === 'perturbed') return `perturbed: ${r.source.kind}`;
  return 'reference';
}
