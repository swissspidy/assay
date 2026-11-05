/** Shapes shared by the real-app evaluation (ADR 0009). */
import type { BrowserContext, Page } from '@playwright/test';
import type { EvidenceSnapshot } from '../../../src/index.ts';
import type { Probe } from '../../../src/playwright/index.ts';

export type AppName = 'gitea' | 'wordpress' | 'prestashop';

/** What the deterministic oracle concluded from the app's backend state after a run. */
export interface OracleResult {
  success: boolean;
  /** One line: which condition held or failed. */
  reason: string;
  /** The backend facts the decision rests on (kept in the run file for audit). */
  facts?: unknown;
}

export interface RealTask {
  /** File stem, e.g. "g01-create-issue". */
  id: string;
  instruction: string;
  /** The page the agent starts on (path relative to the app's base URL). */
  start: string;
  /** Which seeded account the browser is signed in as when the run starts. */
  user: string;
  /** Generic stress variants that do not apply (see ADR 0003). */
  skipVariants?: string[];
  /** Puts the app into the task's starting state (e.g. a filled cart), signed in, before the baseline. */
  setup?(page: Page, app: RealApp): Promise<void>;
  /** A scripted, known-correct solution: the compiler's reference run. */
  reference(page: Page, app: RealApp): Promise<void>;
  /**
   * Further scripted correct solutions through another UI route (the block editor instead of
   * Quick Edit, the public site instead of the admin), stored as `reference-<name>` and given to
   * the compiler with the reference (ADR 0011). Never scored.
   */
  alternatives?: { name: string; route: string; run(page: Page, app: RealApp): Promise<void> }[];
  /** How `reference` does the task, in a few words (shown to the compiler when there are alternatives). */
  route?: string;
  /** Scripted near misses (wrong item, partial, ...), used where agent runs gave too few failures. */
  perturbations?: { name: string; kind: string; run(page: Page, app: RealApp): Promise<void> }[];
  /**
   * The ground truth: reads the app's backend (database or admin API) after the run, plus,
   * for tasks whose outcome is a view, the final URL. Written before any run was labelled.
   */
  oracle(app: RealApp, end: { url: string }): Promise<OracleResult>;
  /** How the oracle decides, in one sentence (documented in the task table). */
  oracleDoc: string;
}

export interface RealApp {
  name: AppName;
  /** What it is, for reports. */
  title: string;
  baseURL: string;
  /** Starts the containers, installs and seeds on first start, and saves the pristine state. */
  start(): Promise<void>;
  /** Restores the pristine seeded state (fast). */
  reset(): Promise<void>;
  stop(): Promise<void>;
  /** Signs `user` in on a fresh context (cookies only; no evidence recorder is attached yet). */
  signIn(context: BrowserContext, user: string): Promise<void>;
  /** Read-only backend probes captured into every snapshot (same set for every task). */
  probes(page: Page): Record<string, Probe>;
  tasks: RealTask[];
}

export type RunSource =
  /** `route`: how a scripted reference did the task, when the task has more than one. */
  | { type: 'reference'; route?: string }
  | { type: 'perturbed'; kind: string }
  | {
      type: 'agent';
      model: string;
      status: string;
      steps: number;
      report?: string;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
      costUsd: number;
      /** The agent's actions, one line each. */
      actions: string[];
    };

/** One labelled run as stored under eval/real/runs/<app>/<task>/<run>.json.gz. */
export interface RunFile {
  label: {
    expected: 'success' | 'fail';
    kind: string;
    /** "oracle": decided by the task's oracle over backend state; "judgment": by a human, with a note. */
    method: 'oracle' | 'judgment';
    oracle: OracleResult;
    note?: string;
  };
  source: RunSource;
  snapshot: EvidenceSnapshot;
}
