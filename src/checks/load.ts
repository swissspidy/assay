/**
 * Check set files: `*.checks.json`, or a TypeScript (or JavaScript) module whose default export
 * is a check set, such as a `*.checks.ts` written with the builder (ADR 0019). TypeScript runs
 * through Node's type stripping (Node 24), so a module uses only erasable syntax.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A check set module rather than JSON. */
export const MODULE_FILE = /\.(ts|mts|js|mjs)$/i;
/** File names of check sets that commands discover in a directory. */
export const CHECK_SET_GLOBS = ['**/*.checks.json', '**/*.checks.ts'] as const;
/** A check set file name: what `assay watch` and `assay bench` treat as a task. */
export const CHECK_SET_FILE = /\.checks\.(json|ts)$/;

export const isModuleFile = (path: string) => MODULE_FILE.test(path);

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

/** The default export, unwrapped once more from a CommonJS-compiled module, and called if it is a function. */
async function defaultExport(mod: { default?: unknown }, path: string): Promise<unknown> {
  let v = mod.default;
  if (isObject(v) && 'default' in v && Object.keys(v).every((k) => k === 'default' || k === '__esModule'))
    v = v.default;
  if (typeof v === 'function') v = await (v as () => unknown)();
  if (v === undefined)
    throw new CheckSetFileError(`cannot load ${path}: no default export (export default checks(…))`, 'ELOAD');
  // As JSON: builders become their JSON, and nothing but plain data is left.
  return JSON.parse(JSON.stringify(v)) as unknown;
}

/**
 * The check set in a file, not yet validated: JSON parsed, or a module's default export (an
 * object, or a function returning one). `fresh` runs a module in a new Node process, so edits
 * to it and to every module it imports are seen (`assay watch`); otherwise a module is imported
 * once per process.
 */
export async function loadCheckSetFile(path: string, opts: { fresh?: boolean } = {}): Promise<unknown> {
  const file = resolve(path);
  if (!isModuleFile(file)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new CheckSetFileError(
        code === 'ENOENT' ? `check set not found: ${path}` : `cannot read check set ${path}: ${(e as Error).message}`,
        code,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new CheckSetFileError(`check set ${path} is not valid JSON: ${(e as Error).message}`, 'EJSON');
    }
  }
  try {
    readFileSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new CheckSetFileError(
      code === 'ENOENT' ? `check set not found: ${path}` : `cannot read check set ${path}: ${(e as Error).message}`,
      code,
    );
  }
  if (opts.fresh) return JSON.parse(await runFresh(file, path)) as unknown;
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (e) {
    throw new CheckSetFileError(`cannot load ${path}: ${e instanceof Error ? e.message : String(e)}`, 'ELOAD', {
      cause: e,
    });
  }
  return defaultExport(mod, path);
}

/** Run the module in a child Node process and return its default export as JSON. */
function runFresh(file: string, shown: string): Promise<string> {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(file).href)});
let v = m.default;
if (v && typeof v === 'object' && 'default' in v && Object.keys(v).every((k) => k === 'default' || k === '__esModule')) v = v.default;
if (typeof v === 'function') v = await v();
if (v === undefined) { process.stderr.write('no default export (export default checks(…))'); process.exit(3); }
process.stdout.write(JSON.stringify(v));`;
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--no-warnings', '-e', script],
      { maxBuffer: 256 << 20, cwd: process.cwd() },
      (err, stdout, stderr) => {
        if (!err) return done(stdout);
        const why = stderr.trim().split('\n').filter(Boolean);
        // The thrown error's message: the line after the stack's first frame header, else the last line.
        const msg = why.find((l) => /^\w*Error\b|^\w+: /.test(l)) ?? why.at(-1) ?? err.message;
        fail(new CheckSetFileError(`cannot load ${shown}: ${msg}`, 'ELOAD'));
      },
    );
  });
}
