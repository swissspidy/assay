/** The example apps used for tests, reference capture, stress testing and evaluation. */
import type { Page, Probe } from './tiny-shop/deps.ts';
import type { TaskDef } from './lib/scenario.ts';
import { TASKS as SHOP } from './tiny-shop/scenarios.ts';
import { TASKS as TRACKER } from './tiny-tracker/scenarios.ts';
import { TASKS as CALENDAR } from './tiny-calendar/scenarios.ts';
import { shopProbes } from './tiny-shop/agent.ts';
import { trackerProbes } from './tiny-tracker/agent.ts';
import { calendarProbes } from './tiny-calendar/agent.ts';

export interface AppDef {
  name: 'tiny-shop' | 'tiny-tracker' | 'tiny-calendar';
  /** Directory with server.mjs, tasks/ and references/. */
  dir: URL;
  port: number;
  tasks: TaskDef[];
  probes(page: Page): Record<string, Probe>;
}

export const APPS: AppDef[] = [
  { name: 'tiny-shop', dir: new URL('./tiny-shop/', import.meta.url), port: 4173, tasks: SHOP, probes: shopProbes },
  {
    name: 'tiny-tracker',
    dir: new URL('./tiny-tracker/', import.meta.url),
    port: 4174,
    tasks: TRACKER,
    probes: trackerProbes,
  },
  {
    name: 'tiny-calendar',
    dir: new URL('./tiny-calendar/', import.meta.url),
    port: 4175,
    tasks: CALENDAR,
    probes: calendarProbes,
  },
];

export const app = (name: string): AppDef => {
  const a = APPS.find((x) => x.name === name);
  if (!a) throw new Error(`unknown app ${name}`);
  return a;
};
