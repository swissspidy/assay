/**
 * Check set files: `*.checks.json`, or a TypeScript (or JavaScript) module whose default export
 * is a check set, such as a `*.checks.ts` written with the builder (ADR 0019). TypeScript runs
 * through Node's type stripping (Node 24), so a module uses only erasable syntax.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A check set module rather than JSON. */
export const MODULE_FILE = /\.(ts|mts|js|mjs)$/i;
/** File names of check sets that commands discover in a directory. */
export const CHECK_SET_GLOBS = ['**/*.checks.json', '**/*.checks.ts'] as const;
/** A check set file name, with every extension a check set file can have. */
export const CHECK_SET_FILE = /\.checks\.(json|ts|mts|js|mjs)$/i;

export const isModuleFile = (path: string) => MODULE_FILE.test(path);

/** A check set file's task name: `02-add-blue-mug.checks.ts` → `02-add-blue-mug`. */
export const checkSetName = (file: string): string => (file.split(/[\\/]/).at(-1) ?? file).replace(CHECK_SET_FILE, '');

/** Every check set the specs name: files, directories (searched) and globs. */
export function discoverSets(specs: string[]): string[] {
  const files = new Set<string>();
  for (const spec of specs) {
    if (existsSync(spec)) {
      if (statSync(spec).isDirectory()) {
        for (const g of CHECK_SET_GLOBS) for (const f of globSync(g, { cwd: spec })) files.add(resolve(spec, f));
      } else files.add(resolve(spec));
    } else for (const f of globSync(spec)) files.add(resolve(f));
  }
  return [...files].filter((f) => !f.split(sep).includes('node_modules')).toSorted();
}

/** A file that could not be read or run. `code` is the file system's error code, if any. */
export class CheckSetFileError extends Error {
  override name = 'CheckSetFileError';
  readonly code: string | undefined;
  constructor(message: string, code?: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The default export, unwrapped once more from a CommonJS-compiled module, and called if it is a function. */
async function defaultExport(mod: { default?: unknown }, path: string): Promise<unknown> {
  let v = mod.default;
  if (isObject(v) && 'default' in v && Object.keys(v).every((k) => k === 'default' || k === '__esModule'))
    v = v.default;
  try {
    if (typeof v === 'function') v = await (v as () => unknown)();
    if (v === undefined)
      throw new CheckSetFileError(`cannot load ${path}: no default export (export default checks(…))`, 'ELOAD');
    // As JSON: builders become their JSON, and nothing but plain data is left.
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch (e) {
    // A factory that rejects, or a value that does not serialize (a cycle, a BigInt), does not load.
    if (e instanceof CheckSetFileError) throw e;
    throw new CheckSetFileError(`cannot load ${path}: ${messageOf(e)}`, 'ELOAD', { cause: e });
  }
}

function readOrThrow(file: string, shown: string): Buffer {
  try {
    return readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new CheckSetFileError(
      code === 'ENOENT' ? `check set not found: ${shown}` : `cannot read check set ${shown}: ${messageOf(e)}`,
      code,
    );
  }
}

/** A loaded check set (not yet validated), and the local files a module set imported. */
export interface LoadedCheckSetFile {
  value: unknown;
  /** Absolute paths of the files the module loaded (itself and its imports outside node_modules); empty for JSON. */
  deps: string[];
}

export interface LoadOptions {
  /**
   * Run a module in a new Node process, so edits to it and to every module it imports are seen
   * (`assay watch`). Otherwise a module is imported in this process, once per version of its
   * contents (an edited set file is imported again; the modules it imports are not).
   */
  fresh?: boolean;
  /** Stops a fresh load (and its process). */
  signal?: AbortSignal;
}

/**
 * The check set in a file, not yet validated: JSON parsed, or a module's default export (an
 * object, or a function returning one).
 */
export async function loadCheckSetFile(path: string, opts: LoadOptions = {}): Promise<unknown> {
  return (await loadCheckSetFileWithDeps(path, opts)).value;
}

/** `loadCheckSetFile`, also returning the files a fresh module load imported. */
export async function loadCheckSetFileWithDeps(path: string, opts: LoadOptions = {}): Promise<LoadedCheckSetFile> {
  const file = resolve(path);
  const content = readOrThrow(file, path);
  if (!isModuleFile(file)) {
    try {
      return { value: JSON.parse(content.toString('utf8')) as unknown, deps: [] };
    } catch (e) {
      throw new CheckSetFileError(`check set ${path} is not valid JSON: ${messageOf(e)}`, 'EJSON');
    }
  }
  if (opts.fresh) return runFresh(file, path, opts.signal);
  // The URL names the version of the file: an edited set is imported again (ESM caches by URL).
  const version = createHash('sha256').update(content).digest('hex').slice(0, 16);
  let mod: { default?: unknown };
  try {
    mod = (await import(`${pathToFileURL(file).href}?v=${version}`)) as { default?: unknown };
  } catch (e) {
    throw new CheckSetFileError(`cannot load ${path}: ${messageOf(e)}`, 'ELOAD', { cause: e });
  }
  return { value: await defaultExport(mod, path), deps: [file] };
}

/**
 * The child's script: record the local modules it loads, import the set, write the result (and
 * the modules) as JSON to a file of its own (module output on stdout cannot corrupt it), then
 * exit at once, so a timer a module started cannot keep the process alive.
 */
const CHILD = `import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const [url, out] = process.argv.slice(-2);
const deps = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (r.url.startsWith('file:') && !r.url.includes('/node_modules/')) deps.add(r.url);
    return r;
  },
});
const m = await import(url);
let v = m.default;
if (v && typeof v === 'object' && 'default' in v && Object.keys(v).every((k) => k === 'default' || k === '__esModule')) v = v.default;
if (typeof v === 'function') v = await v();
if (v === undefined) { process.stderr.write('Error: no default export (export default checks(…))\\n'); process.exit(3); }
writeFileSync(out, JSON.stringify({ value: v, deps: [url, ...deps] }));
process.exit(0);`;

/** Run the module in a child Node process and return its default export as JSON. */
function runFresh(file: string, shown: string, signal: AbortSignal | undefined): Promise<LoadedCheckSetFile> {
  const dir = mkdtempSync(join(tmpdir(), 'assay-load-'));
  const out = join(dir, 'result.json');
  return new Promise<LoadedCheckSetFile>((done, fail) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--no-warnings', '-e', CHILD, '--', pathToFileURL(file).href, out],
      { maxBuffer: 64 << 20, cwd: process.cwd(), ...(signal ? { signal } : {}) },
      (err, _stdout, stderr) => {
        if (err) {
          if (signal?.aborted) return fail(new CheckSetFileError(`loading ${shown} was stopped`, 'EABORT'));
          const why = stderr.trim().split('\n').filter(Boolean);
          // The thrown error's line ("Error: …"), else the last line.
          const msg = why.find((l) => /^\w*Error\b|^\w+: /.test(l)) ?? why.at(-1) ?? err.message;
          return fail(new CheckSetFileError(`cannot load ${shown}: ${msg}`, 'ELOAD'));
        }
        try {
          const r = JSON.parse(readFileSync(out, 'utf8')) as { value: unknown; deps: string[] };
          done({ value: r.value, deps: [...new Set(r.deps.map((u) => fileURLToPath(u.replace(/[?#].*$/, ''))))] });
        } catch (e) {
          fail(new CheckSetFileError(`cannot load ${shown}: ${messageOf(e)}`, 'ELOAD'));
        }
      },
    );
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}
