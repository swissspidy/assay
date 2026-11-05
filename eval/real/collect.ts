/**
 * Produces the labelled runs of the real-app evaluation (ADR 0009):
 *
 *   node eval/real/collect.ts <app> [taskId...] [--kinds reference,perturbed,agent] [--agents sonnet,haiku,haiku]
 *                             [--check-oracles] [--force]
 *
 * For each run the app is reset to its seeded state, the browser signs in, the task's
 * setup runs, a baseline is captured, then the reference script, a perturbation or the
 * browser agent acts. The final snapshot is captured with the app's probes and the
 * task's oracle labels the run from the app's backend state.
 * Writes eval/real/runs/<app>/<task>/<run>.json.gz; existing runs are kept unless --force.
 *
 * --check-oracles only checks each oracle: it must fail on the seeded state, pass after the
 * reference script and fail after every perturbation.
 *
 * Agent runs need ANTHROPIC_API_KEY. Each agent run records its model turns to
 * eval/real/cassettes/agent/<app>/<task>/<run>.json (a transcript: a live app cannot be replayed).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { anthropic } from '@ai-sdk/anthropic';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { LanguageModel } from 'ai';
import { aiSdkModel } from '../../src/model/ai-sdk.ts';
import { recordingModel } from '../../src/model/replay.ts';
import { EvidenceRecorder, captureBaseline, captureSnapshot } from '../../src/playwright/index.ts';
import { costUsd, PRICING } from '../../src/eval/metrics.ts';
import { APPS } from './apps.ts';
import { runBrowserAgent } from './lib/agent.ts';
import type { RealApp, RealTask, RunFile, RunSource } from './lib/types.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [appName, ...taskIds] = positional;
/** Short names by kind of app, as an alternative to the product names. */
const ALIAS: Record<string, string> = { forge: 'gitea', cms: 'wordpress', shop: 'prestashop' };
const app = APPS.find((a) => a.name === (ALIAS[appName ?? ''] ?? appName));
if (!app) throw new Error(`usage: collect.ts <${APPS.map((a) => a.name).join('|')}> [taskId...]`);
const kinds = new Set((flag('kinds') ?? 'reference,perturbed,agent').split(','));
const agents = (flag('agents') ?? 'sonnet,haiku,haiku').split(',').filter(Boolean);
const force = args.includes('--force');
const checkOnly = args.includes('--check-oracles');

const MODELS: Record<string, { id: string; effort: 'low' | 'medium' }> = {
  sonnet: { id: 'claude-sonnet-5-5', effort: 'low' },
  haiku: { id: 'claude-haiku-5-5', effort: 'low' },
};
const root = new URL('./', import.meta.url);
const runPath = (task: string, run: string) => new URL(`runs/${app.name}/${task}/${run}.json.gz`, root);
const PINNED = '1970-01-01T00:00:00.000Z';

function agentModel(name: string, cassette: string) {
  const m = MODELS[name];
  if (!m) throw new Error(`unknown agent model ${name}`);
  // @ai-sdk/anthropic ships a newer @ai-sdk/provider than `ai` 7.0.147 (one more finish reason, which the
  // adapter maps to "other"); the model interface is otherwise the same.
  const inner = aiSdkModel(anthropic(m.id) as unknown as LanguageModel, {
    id: `anthropic:${m.id}@${m.effort}`,
    maxOutputTokens: 8000,
    providerOptions: { anthropic: { effort: m.effort, cacheControl: { type: 'ephemeral' } } },
  });
  return { model: recordingModel(inner, cassette), modelId: m.id };
}

interface Played {
  page: Page;
  close(): Promise<void>;
}

/** A fresh, signed-in browser context on a freshly reset app, with the recorder attached and the baseline taken. */
async function prepare(browser: Browser, task: RealTask): Promise<Played> {
  await app!.reset();
  const context = await browser.newContext({ baseURL: app!.baseURL, viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(15_000);
  await app!.signIn(context, task.user);
  await EvidenceRecorder.attach(context);
  const page = await context.newPage();
  await page.goto(new URL(task.start, app!.baseURL).href);
  if (task.setup) {
    await task.setup(page, app!);
    await page.goto(new URL(task.start, app!.baseURL).href);
  }
  await captureBaseline(page, { probes: app!.probes(page) });
  return { page, close: () => context.close() };
}

async function finishRun(p: Played, task: RealTask, source: RunSource, kind: string, file: URL): Promise<void> {
  await p.page.waitForLoadState('load').catch(() => undefined);
  await p.page.waitForTimeout(500);
  const snapshot = await captureSnapshot(p.page, { probes: app!.probes(p.page) });
  snapshot.capturedAt = PINNED;
  if (snapshot.baseline) snapshot.baseline.capturedAt = PINNED;
  const oracle = await task.oracle(app!, { url: p.page.url() });
  await p.close();
  const run: RunFile = {
    label: {
      expected: oracle.success ? 'success' : 'fail',
      kind: oracle.success ? 'correct' : kind,
      method: 'oracle',
      oracle,
    },
    source,
    snapshot,
  };
  mkdirSync(new URL('./', file), { recursive: true });
  writeFileSync(file, gzipSync(JSON.stringify(run) + '\n', { level: 9 }));
  console.warn(
    `${app!.name}/${task.id}/${file.pathname
      .split('/')
      .pop()!
      .replace(/\.json\.gz$/, '')}: ${run.label.expected} (${oracle.reason})`,
  );
}

async function checkOracles(browser: Browser, task: RealTask): Promise<string[]> {
  const problems: string[] = [];
  await app!.reset();
  const seeded = await task.oracle(app!, { url: new URL(task.start, app!.baseURL).href });
  if (seeded.success) problems.push(`passes on the seeded state (${seeded.reason})`);
  const scripts: [string, (page: Page, a: RealApp) => Promise<void>, boolean][] = [
    ['reference', task.reference, true],
    ...(task.alternatives ?? []).map((x) => [`reference-${x.name}`, x.run, true] as [string, typeof x.run, boolean]),
    ...(task.perturbations ?? []).map((x) => [x.name, x.run, false] as [string, typeof x.run, boolean]),
  ];
  for (const [name, script, want] of scripts) {
    const p = await prepare(browser, task);
    try {
      await script(p.page, app!);
      await p.page.waitForTimeout(500);
      const o = await task.oracle(app!, { url: p.page.url() });
      if (o.success !== want) problems.push(`${name}: oracle says ${o.success} (${o.reason})`);
      else console.warn(`  ${name}: ${o.success} (${o.reason})`);
    } catch (e) {
      problems.push(`${name}: script failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      await p.page
        .screenshot({ path: `${process.env.ASSAY_REAL_DEBUG ?? '/tmp'}/${task.id}-${name}.png` })
        .catch(() => {});
    } finally {
      await p.close();
    }
  }
  return problems;
}

const browser = await chromium.launch(process.env.ASSAY_CHROMIUM ? { executablePath: process.env.ASSAY_CHROMIUM } : {});
let failures = 0;
let spend = 0;
try {
  await app.start();
  for (const task of app.tasks) {
    if (taskIds.length && !taskIds.some((t) => task.id === t || task.id.startsWith(`${t}-`))) continue;
    if (checkOnly) {
      const problems = await checkOracles(browser, task);
      console.warn(`${task.id}: ${problems.length ? problems.join('; ') : 'oracle ok'}`);
      if (problems.length) failures++;
      continue;
    }
    const jobs: {
      name: string;
      kind: string;
      play: (page: Page) => Promise<RunSource>;
    }[] = [];
    if (kinds.has('reference')) {
      jobs.push({
        name: 'reference',
        kind: 'correct',
        play: async (page) => {
          await task.reference(page, app);
          return { type: 'reference', ...(task.alternatives?.length && task.route ? { route: task.route } : {}) };
        },
      });
      for (const alt of task.alternatives ?? []) {
        jobs.push({
          name: `reference-${alt.name}`,
          kind: 'correct',
          play: async (page) => {
            await alt.run(page, app);
            return { type: 'reference', route: alt.route };
          },
        });
      }
    }
    if (kinds.has('perturbed')) {
      for (const p of task.perturbations ?? []) {
        jobs.push({
          name: p.name,
          kind: p.kind,
          play: async (page) => {
            await p.run(page, app);
            return { type: 'perturbed', kind: p.kind };
          },
        });
      }
    }
    if (kinds.has('agent')) {
      const seen = new Map<string, number>();
      for (const a of agents) {
        const n = (seen.get(a) ?? 0) + 1;
        seen.set(a, n);
        const name = `agent-${a}-${n}`;
        jobs.push({
          name,
          kind: 'agent-failure',
          play: async (page) => {
            const cassette = new URL(`cassettes/agent/${app.name}/${task.id}/${name}.json`, root).pathname;
            const { model, modelId } = agentModel(a, cassette);
            const r = await runBrowserAgent(page, { model, task: task.instruction });
            model.save();
            const cost = costUsd(r.usage, PRICING[modelId]);
            spend += cost;
            return {
              type: 'agent',
              model: `${model.id}`,
              status: r.status,
              steps: r.steps,
              ...(r.report !== undefined ? { report: r.report } : {}),
              usage: r.usage,
              costUsd: Math.round(cost * 1e4) / 1e4,
              actions: r.actions,
            };
          },
        });
      }
    }
    for (const job of jobs) {
      const file = runPath(task.id, job.name);
      if (existsSync(file) && !force) continue;
      let p: Played | undefined;
      try {
        p = await prepare(browser, task);
        const source = await job.play(p.page);
        await finishRun(p, task, source, job.kind, file);
      } catch (e) {
        failures++;
        console.warn(`${app.name}/${task.id}/${job.name}: FAILED ${e instanceof Error ? e.stack : String(e)}`);
        await p?.close().catch(() => {});
      }
    }
  }
} finally {
  await browser.close();
  if (!process.env.ASSAY_REAL_KEEP) await app.stop();
}
if (spend) console.warn(`agent spend this run: $${spend.toFixed(3)}`);
process.exitCode = failures ? 1 : 0;
