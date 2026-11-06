/**
 * `assay.config.ts`: one place for the model and the project's defaults (ADR 0017).
 *
 * Precedence, for every setting: command-line flags, then environment variables, then
 * the config file, then built-in defaults. In the library, explicit options win over the
 * config file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
]);
const MODEL_OPTION_KEYS = new Set(['mode', 'id', 'providerOptions', 'maxOutputTokens', 'maxRetries']);
const STRESS_KEYS = new Set(['skipVariants', 'successClaims']);

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
    c[k] = resolve(dir, c[k]);
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
  if (c.escalate !== undefined && typeof c.escalate !== 'boolean' && !isObject(c.escalate))
    throw bad('escalate', 'true, false or { on, includeSoft }');
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
  return c;
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
