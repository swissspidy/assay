/** The example apps used for tests, reference capture, stress testing and evaluation. */
import type { Page, Probe } from './tiny-shop/deps.ts';
import { readFileSync } from 'node:fs';
import type { TaskDef } from './lib/scenario.ts';
import { TASKS as SHOP } from './tiny-shop/scenarios.ts';
import { TASKS as TRACKER } from './tiny-tracker/scenarios.ts';
import { TASKS as CALENDAR } from './tiny-calendar/scenarios.ts';
import { shopProbes } from './tiny-shop/agent.ts';
import { trackerProbes } from './tiny-tracker/agent.ts';
import { calendarProbes } from './tiny-calendar/agent.ts';

/** A simulated release of an example app (releases.json); versions apply cumulatively. */
export interface Release {
  version: number;
  name: string;
  summary: string;
  html?: [string, string][];
  flags?: string[];
  /** Tasks whose correct runs no longer achieve the outcome in this release (a regression). */
  breaks?: string[];
}

export interface AppDef {
  name: 'tiny-shop' | 'tiny-tracker' | 'tiny-calendar';
  /** Directory with server.mjs, tasks/ and references/. */
  dir: URL;
  port: number;
  tasks: TaskDef[];
  probes(page: Page): Record<string, Probe>;
  /** Releases 2..N; version 1 is the app as recorded. */
  releases: Release[];
}

const releases = (dir: string): Release[] =>
  (JSON.parse(readFileSync(new URL(`./${dir}/releases.json`, import.meta.url), 'utf8')) as { releases: Release[] })
    .releases;

/** The task's expected verdict for a scenario in a given app version (a regression breaks correct runs). */
export const expectedIn = (app: AppDef, version: number, taskId: string, expected: 'success' | 'fail') =>
  expected === 'success' && app.releases.some((r) => r.version <= version && r.breaks?.includes(taskId))
    ? 'fail'
    : expected;

/** Highest version any app has. */
export const latestVersion = (app: AppDef) => Math.max(1, ...app.releases.map((r) => r.version));

export const APPS: AppDef[] = [
  {
    name: 'tiny-shop',
    dir: new URL('./tiny-shop/', import.meta.url),
    port: 4173,
    tasks: SHOP,
    probes: shopProbes,
    releases: releases('tiny-shop'),
  },
  {
    name: 'tiny-tracker',
    dir: new URL('./tiny-tracker/', import.meta.url),
    port: 4174,
    tasks: TRACKER,
    probes: trackerProbes,
    releases: releases('tiny-tracker'),
  },
  {
    name: 'tiny-calendar',
    dir: new URL('./tiny-calendar/', import.meta.url),
    port: 4175,
    tasks: CALENDAR,
    probes: calendarProbes,
    releases: releases('tiny-calendar'),
  },
];

export const app = (name: string): AppDef => {
  const a = APPS.find((x) => x.name === name);
  if (!a) throw new Error(`unknown app ${name}`);
  return a;
};
