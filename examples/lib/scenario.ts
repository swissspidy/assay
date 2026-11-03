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
  run(page: Page): Promise<void>;
}

export interface TaskDef {
  /** File stem under tasks/ (handwritten check set, also the task text). */
  id: string;
  /** Probes the task's checks may use. */
  probes: string[];
  /** Generic stress variants that do not apply to this task (see src/stress/variants.ts). */
  skipVariants?: string[];
  scenarios: Scenario[];
}

export const ok = (name: string, run: (page: Page) => Promise<void>): Scenario => ({
  name,
  expected: 'success',
  kind: 'correct',
  run,
});
export const bad = (name: string, kind: ScenarioKind, run: (page: Page) => Promise<void>): Scenario => ({
  name,
  expected: 'fail',
  kind,
  run,
});

/**
 * The one correct run a task's checks are compiled from (milestone 2). The
 * evaluation of compiled checks leaves it out, so every scored run is held out.
 */
export const compileReference = (def: TaskDef): Scenario => {
  const s = def.scenarios.find((x) => x.expected === 'success');
  if (!s) throw new Error(`task ${def.id} has no correct scenario`);
  return s;
};
