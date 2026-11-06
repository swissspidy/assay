/**
 * `assay.config.ts`: one place for the model and the project's defaults (ADR 0017).
 *
 * Precedence, for every setting: command-line flags, then environment variables, then
 * the config file, then built-in defaults. In the library, explicit options win over the
 * config file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelInput, ModelOptions } from '../model/resolve.ts';
import { pemBlocks } from '../verifier/sign.ts';

/** File names looked for in the project root, in this order. */
export const CONFIG_FILES = ['assay.config.ts', 'assay.config.mts', 'assay.config.js', 'assay.config.mjs'] as const;

export interface AssayConfig {
  /**
   * The model that compiles checks and decides escalated requirements: a `'provider:model'`
   * string, any Vercel AI SDK language model, or an adapter `{ id, turn(request) }`.
   * Only `compile` and escalation use it; nothing else ever needs a model.
   */
  model?: ModelInput;
  /** How to drive the model and what to call it (mode, id, AI SDK options). */
  modelOptions?: ModelOptions;
  /**
   * Where check sets live: a directory (every `*.checks.json` under it) or a glob.
   * `assay validate` with no files validates these.
   */
  checks?: string;
  /** Where snapshots live: the default output directory of `assay capture`. */
  snapshots?: string;
  /** Write an outcome record for every `verify` under this directory. */
  recordDir?: string;
  /**
   * Escalate what the checks abstain on to the agentic verifier, with `model` (default
   * false). An object sets the policy: `{ on: ['abstain', 'fail'], includeSoft: true }`.
   */
  escalate?: boolean | { on?: ('abstain' | 'fail')[]; includeSoft?: boolean };
  /** Refuse check sets without a valid lock; `'signed'` also needs a signature by a trusted key. */
  requireLocked?: boolean | 'signed';
  /** Trusted Ed25519 public keys: PEM files, directories of `.pem` files, or PEM text. */
  trustedKeys?: string[];
  /** Defaults for `assay stress` and `stressTest`. */
  stress?: {
    /** Variant ids that do not apply to these tasks (e.g. `reorder`). */
    skipVariants?: string[];
    /** Re-run rejected mutants with a success claim added to the page (default true). */
    successClaims?: boolean;
  };
  /** Defaults for `assay bench`: comparing models on this project's tasks (ADR 0018). */
  bench?: BenchConfig;
}

/**
 * A model to compare in `assay bench`: any `model` form (a `'provider:model'` string, an AI
 * SDK model, an adapter), a path to a module whose default export is one (`'./my-adapter.ts'`),
 * or `{ name, model, options }` to name it and set its options.
 */
export type BenchModelInput = ModelInput | { name: string; model: ModelInput; options?: ModelOptions };

export interface BenchConfig {
  /** The models to compare, in this order (default: `model`). */
  models?: BenchModelInput[];
  /**
   * The task files: a directory (every `*.checks.json` and `*.task.json` under it) or a glob.
   * Default: `checks`.
   */
  tasks?: string;
  /**
   * A directory with one subdirectory of runs per task, named like the task file
   * (`references/add-blue-mug/*.json` for `add-blue-mug.checks.json`). Default: `references`
   * next to the tasks directory.
   */
  references?: string;
  /** Where `assay bench --record` writes cassettes and replays read them (default: `assay-bench`). */
  cassettes?: string;
  /** Repeats per model and task (default 1). */
  runs?: number;
  /** Compiles running at once (default 2). */
  concurrency?: number;
}

/** Type the config file: `export default defineConfig({ model: 'anthropic:claude-opus-5-5' })`. */
export function defineConfig(config: AssayConfig): AssayConfig {
  return config;
}

export interface LoadedConfig {
  config: AssayConfig;
  /** The file it came from; absent when there is none. */
  path?: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const KEYS = new Set<string>([
  'model',
  'modelOptions',
  'checks',
  'snapshots',
  'recordDir',
  'escalate',
  'requireLocked',
  'trustedKeys',
  'stress',
  'bench',
]);
const MODEL_OPTION_KEYS = new Set(['mode', 'id', 'providerOptions', 'maxOutputTokens', 'maxRetries']);
const STRESS_KEYS = new Set(['skipVariants', 'successClaims']);
const BENCH_KEYS = new Set(['models', 'tasks', 'references', 'cassettes', 'runs', 'concurrency']);

const GLOB = /[*?[\]{}]/;
/** A path as a glob that matches only itself: each glob character in a one-character class. */
export const escapeGlob = (path: string) => path.replace(/[*?[\]{}]/g, (ch) => `[${ch}]`);

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isPem = (s: string) => s.includes('-----BEGIN');

/** Check the shape (unknown keys are typos), and make the paths in it absolute against `dir`. */
export function normalizeConfig(raw: unknown, dir: string, where = 'assay config'): AssayConfig {
  if (!isObject(raw)) throw new ConfigError(`${where} must export an object (export default defineConfig({ … }))`);
  const bad = (key: string, want: string) => new ConfigError(`${where}: \`${key}\` must be ${want}`);
  for (const k of Object.keys(raw)) {
    if (!KEYS.has(k)) throw new ConfigError(`${where}: unknown option \`${k}\` (options: ${[...KEYS].join(', ')})`);
  }
  const c = { ...raw } as AssayConfig & Record<string, unknown>;
  for (const k of ['checks', 'snapshots', 'recordDir'] as const) {
    if (c[k] === undefined) continue;
    if (typeof c[k] !== 'string' || !c[k]) throw bad(k, 'a path');
    // A relative glob keeps the config's directory literal, even with glob characters in its name.
    const glob = k === 'checks' && GLOB.test(c[k]) && !existsSync(resolve(dir, c[k]));
    c[k] = glob && !isAbsolute(c[k]) ? `${escapeGlob(resolve(dir))}/${c[k]}` : resolve(dir, c[k]);
  }
  if (c.modelOptions !== undefined) {
    if (!isObject(c.modelOptions)) throw bad('modelOptions', 'an object');
    for (const k of Object.keys(c.modelOptions)) {
      if (!MODEL_OPTION_KEYS.has(k))
        throw new ConfigError(`${where}: unknown option \`modelOptions.${k}\` (${[...MODEL_OPTION_KEYS].join(', ')})`);
    }
    const mode = c.modelOptions.mode;
    if (mode !== undefined && (typeof mode !== 'string' || !['auto', 'tools', 'json'].includes(mode)))
      throw bad('modelOptions.mode', '"auto", "tools" or "json"');
  }
  if (c.escalate !== undefined && typeof c.escalate !== 'boolean') {
    if (!isObject(c.escalate)) throw bad('escalate', 'true, false or { on, includeSoft }');
    for (const k of Object.keys(c.escalate)) {
      if (k !== 'on' && k !== 'includeSoft')
        throw new ConfigError(`${where}: unknown option \`escalate.${k}\` (on, includeSoft)`);
    }
    const { on, includeSoft } = c.escalate as Record<string, unknown>;
    if (on !== undefined && (!Array.isArray(on) || on.some((x) => x !== 'abstain' && x !== 'fail')))
      throw bad('escalate.on', 'an array of "abstain" and "fail"');
    if (includeSoft !== undefined && typeof includeSoft !== 'boolean')
      throw bad('escalate.includeSoft', 'true or false');
  }
  if (c.requireLocked !== undefined && typeof c.requireLocked !== 'boolean' && c.requireLocked !== 'signed')
    throw bad('requireLocked', 'true, false or "signed"');
  if (c.trustedKeys !== undefined) {
    if (!Array.isArray(c.trustedKeys) || c.trustedKeys.some((k) => typeof k !== 'string'))
      throw bad('trustedKeys', 'an array of paths or PEM text');
    c.trustedKeys = c.trustedKeys.map((k) => (isPem(k) ? k : resolve(dir, k)));
  }
  if (c.requireLocked === 'signed' && !c.trustedKeys?.length)
    throw new ConfigError(`${where}: \`requireLocked: "signed"\` needs \`trustedKeys\``);
  if (c.stress !== undefined) {
    if (!isObject(c.stress)) throw bad('stress', 'an object');
    for (const k of Object.keys(c.stress)) {
      if (!STRESS_KEYS.has(k))
        throw new ConfigError(`${where}: unknown option \`stress.${k}\` (${[...STRESS_KEYS].join(', ')})`);
    }
  }
  if (c.bench !== undefined) c.bench = normalizeBench(c.bench, dir, where);
  return c;
}

function normalizeBench(raw: unknown, dir: string, where: string): BenchConfig {
  const bad = (key: string, want: string) => new ConfigError(`${where}: \`bench.${key}\` must be ${want}`);
  if (!isObject(raw)) throw new ConfigError(`${where}: \`bench\` must be an object`);
  for (const k of Object.keys(raw)) {
    if (!BENCH_KEYS.has(k))
      throw new ConfigError(`${where}: unknown option \`bench.${k}\` (${[...BENCH_KEYS].join(', ')})`);
  }
  const b = { ...raw } as BenchConfig & Record<string, unknown>;
  if (b.models !== undefined) {
    if (!Array.isArray(b.models) || !b.models.length) throw bad('models', 'a non-empty array of models');
    for (const m of b.models) {
      const named = isObject(m) && 'name' in m && 'model' in m && !('turn' in m);
      if (named && (typeof m.name !== 'string' || !m.name)) throw bad('models', 'models with a string `name`');
      if (m === null || (typeof m !== 'string' && typeof m !== 'object' && typeof m !== 'function'))
        throw bad('models', 'an array of models: "provider:model", a module path, an AI SDK model or an adapter');
    }
  }
  for (const k of ['tasks', 'references', 'cassettes'] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'string' || !b[k]) throw bad(k, 'a path');
    const glob = k === 'tasks' && GLOB.test(b[k]) && !existsSync(resolve(dir, b[k]));
    b[k] = glob && !isAbsolute(b[k]) ? `${escapeGlob(resolve(dir))}/${b[k]}` : resolve(dir, b[k]);
  }
  for (const k of ['runs', 'concurrency'] as const) {
    if (b[k] !== undefined && (!Number.isInteger(b[k]) || (b[k] as number) < 1)) throw bad(k, 'a positive integer');
  }
  return b;
}

/** The config file in `cwd`, if there is one. */
export function findConfig(cwd = process.cwd()): string | undefined {
  for (const f of CONFIG_FILES) {
    const p = join(cwd, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}

const cache = new Map<string, Promise<LoadedConfig>>();

/**
 * Load the project's config: `path` if given, else the first of `assay.config.{ts,mts,js,mjs}`
 * in `cwd` (default: the current directory). Without one, the config is empty. Loads are
 * cached per file. TypeScript configs run through Node's type stripping (Node 24), so they
 * use only erasable syntax (no `enum`).
 */
export function loadConfig(opts: { cwd?: string; path?: string } = {}): Promise<LoadedConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const path = opts.path !== undefined ? resolve(cwd, opts.path) : findConfig(cwd);
  const key = path ?? `none:${cwd}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async (): Promise<LoadedConfig> => {
      if (!path) return { config: {} };
      if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
      let mod: { default?: unknown };
      try {
        mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
      } catch (e) {
        throw new ConfigError(`cannot load ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      let raw = mod.default;
      // A config compiled to CommonJS by a loader (tsx, a test runner) arrives wrapped once more.
      if (isObject(raw) && 'default' in raw && Object.keys(raw).every((k) => k === 'default' || k === '__esModule'))
        raw = raw.default;
      if (typeof raw === 'function') raw = await (raw as () => unknown)();
      return { config: normalizeConfig(raw, dirname(path), path), path };
    })();
    cache.set(key, hit);
    // A failed load is not cached: the next call sees a fixed file.
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

/** Trusted keys from config entries: PEM text, PEM files (several keys each) or directories of `.pem` files. */
export function readTrustedKeys(entries: readonly string[]): { name?: string; key: string }[] {
  const keys: { name?: string; key: string }[] = [];
  const blocks = pemBlocks;
  for (const entry of entries) {
    if (isPem(entry)) {
      keys.push(...blocks(entry).map((key) => ({ key })));
      continue;
    }
    if (!existsSync(entry)) throw new ConfigError(`trusted key not found: ${entry}`);
    const files = statSync(entry).isDirectory()
      ? readdirSync(entry)
          .filter((f) => f.endsWith('.pem'))
          .toSorted()
          .map((f) => join(entry, f))
      : [entry];
    if (!files.length) throw new ConfigError(`no .pem files in ${entry}`);
    for (const f of files) {
      const found = blocks(readFileSync(f, 'utf8'));
      if (!found.length) throw new ConfigError(`${f} holds no PEM key`);
      const name = f.replace(/^.*[\\/]/, '').replace(/(\.pub)?\.pem$/, '');
      for (const key of found) keys.push({ ...(found.length === 1 ? { name } : {}), key });
    }
  }
  return keys;
}

/**
 * A loader that runs once and is then cached, unless it fails: a rejected load is forgotten,
 * so the next call tries again (a config fixed meanwhile, a flaky async config function).
 */
export function cachedUntilRejected<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) {
      const p = load();
      cached = p;
      p.catch(() => {
        if (cached === p) cached = undefined;
      });
    }
    return cached;
  };
}
