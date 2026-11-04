/** Shared shape of labelled, scripted trajectories for the example apps. */
import type { Page } from '../tiny-shop/deps.ts';

export type ScenarioKind =
  | 'correct'
  | 'wrong-item'
  | 'partial'
  | 'over-completion'
  | 'no-op'
  | 'adversarial'
  | 'undone';

export interface Scenario {
  name: string;
  expected: 'success' | 'fail';
  kind: ScenarioKind;
  /**
   * Puts the app in the state the task starts from (e.g. the user's cart), before
   * the agent acts. Runners capture a baseline after it (captureBaseline).
   */
  setup?(page: Page): Promise<void>;
  run(page: Page): Promise<void>;
}

type Setup = (page: Page) => Promise<void>;

export interface TaskDef {
  /** File stem under tasks/ (handwritten check set, also the task text). */
  id: string;
  /** Probes the task's checks may use. */
  probes: string[];
  /** Generic stress variants that do not apply to this task (see src/stress/variants.ts). */
  skipVariants?: string[];
  scenarios: Scenario[];
}

export const ok = (name: string, run: (page: Page) => Promise<void>, setup?: Setup): Scenario => ({
  name,
  expected: 'success',
  kind: 'correct',
  ...(setup ? { setup } : {}),
  run,
});
export const bad = (name: string, kind: ScenarioKind, run: (page: Page) => Promise<void>, setup?: Setup): Scenario => ({
  name,
  expected: 'fail',
  kind,
  ...(setup ? { setup } : {}),
  run,
});

/**
 * Plays a scenario on a page: its setup, then a baseline of the starting state
 * (when it has a setup), then the agent's run.
 */
export async function play(s: Scenario, page: Page, baseline: (page: Page) => Promise<unknown>): Promise<void> {
  if (s.setup) {
    await s.setup(page);
    await baseline(page);
  }
  await s.run(page);
}

/**
 * The one correct run a task's checks are compiled from (milestone 2). The
 * evaluation of compiled checks leaves it out, so every scored run is held out.
 */
export const compileReference = (def: TaskDef): Scenario => {
  const s = def.scenarios.find((x) => x.expected === 'success');
  if (!s) throw new Error(`task ${def.id} has no correct scenario`);
  return s;
};
