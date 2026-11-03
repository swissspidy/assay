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
