/**
 * Output, errors and file loading for the `assay` command-line tool. Kept free of
 * the library's heavier modules so `assay --help` starts fast.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { styleText } from 'node:util';
import type { EvidenceSnapshot } from '../types.ts';
import { loadSnapshot } from '../snapshot/load.ts';

/** The exit-code contract (ADR 0010). */
export const EXIT = {
  /** Success: the run succeeded, the check set is valid, no stress problems. */
  ok: 0,
  /** A definite negative result: verdict fail, invalid check set, stress problems, compile refused. */
  fail: 1,
  /** Inconclusive: the verdict is abstain. */
  inconclusive: 2,
  /** Usage error: unknown command or option, missing or extra arguments. */
  usage: 3,
  /** Any other error: unreadable input, missing dependency or key, model or internal error. */
  error: 4,
} as const;

/** Parsed option values. */
export type Values = Record<string, string | boolean | string[] | undefined>;

/** A parsed command line. */
export interface Invocation {
  command: string;
  values: Values;
  positionals: string[];
}

/** An error with a message meant for the user and the exit code it maps to. */
export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code: number = EXIT.error) {
    super(message);
    this.code = code;
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.usage);
    this.name = 'UsageError';
  }
}

export interface Io {
  /** Write a line (or lines) to stdout. */
  out(text: string): void;
  /** Write a line (or lines) to stderr. */
  err(text: string): void;
  /** Colour stdout. */
  color: boolean;
  /** Colour stderr. */
  errColor: boolean;
  env: Record<string, string | undefined>;
  /** Where to look for assay.config.ts and write `assay init`'s file (default: the process's directory). */
  cwd?: string;
  /** Stops a long command early (`assay bench`); default: Ctrl-C. */
  signal?: AbortSignal;
}

/** Colour only on a terminal that supports it; tty's hasColors honours NO_COLOR and FORCE_COLOR. */
const hasColors = (s: NodeJS.WriteStream) => !!(s.isTTY && s.hasColors?.());

/**
 * A writer that stops quietly once the reader goes away (EPIPE, e.g. `assay review x | head -1`):
 * the command still finishes and exits with its own status, without a stack trace.
 */
export function lineWriter(stream: NodeJS.WritableStream): (text: string) => void {
  let closed = false;
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') closed = true;
    else throw e;
  });
  return (text) => {
    if (!closed) stream.write(text + '\n');
  };
}

export function processIo(): Io {
  return {
    out: lineWriter(process.stdout),
    err: lineWriter(process.stderr),
    color: hasColors(process.stdout),
    errColor: hasColors(process.stderr),
    env: process.env,
  };
}

type Style = 'red' | 'green' | 'yellow' | 'bold' | 'dim';

export const paint = (on: boolean, style: Style, text: string) =>
  on ? styleText(style, text, { validateStream: false }) : text;

/** Colour the status icons and the verdict line of a plain-text report. */
export function colorReport(on: boolean, text: string): string {
  if (!on) return text;
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)(✔)/, (_, s, i) => s + paint(true, 'green', i))
        .replace(/^(\s*)(✘)/, (_, s, i) => s + paint(true, 'red', i))
        .replace(/^(\s*)(\?) /, (_, s, i) => s + paint(true, 'yellow', i) + ' ')
        .replace(/^Verdict: (SUCCESS|FAIL|ABSTAIN)/, (_, v: string) => {
          const style = v === 'SUCCESS' ? 'green' : v === 'FAIL' ? 'red' : 'yellow';
          return `Verdict: ${paint(true, 'bold', paint(true, style, v))}`;
        }),
    )
    .join('\n');
}

export function readText(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new CliError(
      code === 'ENOENT' ? `${what} not found: ${path}` : `cannot read ${what} ${path}: ${(e as Error).message}`,
    );
  }
}

export function readJson(path: string, what: string): unknown {
  const text = readText(path, what);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${what} ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** A snapshot file as stored: either the snapshot itself, or a labelled run `{ label, snapshot }`. */
export interface SnapshotFile {
  /** The file name without `.json`, used as the reference name. */
  name: string;
  path: string;
  /** The run's label (`label.expected`), when the file has one. */
  expected?: 'success' | 'fail';
  snapshot: unknown;
}

export function readSnapshotFile(path: string): SnapshotFile {
  const json = readJson(path, 'snapshot');
  const name = basename(path).replace(/\.json$/, '');
  if (isObject(json) && json.schema === undefined && isObject(json.snapshot)) {
    const expected = isObject(json.label) ? json.label.expected : undefined;
    return {
      name,
      path,
      ...(expected === 'success' || expected === 'fail' ? { expected } : {}),
      snapshot: json.snapshot,
    };
  }
  return { name, path, snapshot: json };
}

/** The file's snapshot, validated as `loadSnapshot` does. */
export function toSnapshot(f: SnapshotFile): EvidenceSnapshot {
  try {
    return loadSnapshot(f.snapshot);
  } catch (e) {
    throw new CliError(`${f.path} is not an evidence snapshot: ${(e as Error).message}`);
  }
}

/** A snapshot file, or every `.json` file in a directory (sorted by name). */
export function readSnapshots(path: string): SnapshotFile[] {
  if (!existsSync(path)) throw new CliError(`snapshot not found: ${path}`);
  if (!statSync(path).isDirectory()) return [readSnapshotFile(path)];
  const files = readdirSync(path)
    .filter((f) => f.endsWith('.json'))
    .toSorted();
  if (!files.length) throw new CliError(`no .json snapshots in ${path}`);
  return files.map((f) => readSnapshotFile(join(path, f)));
}

/** Split a comma-separated option ("a,b") into its parts. */
export const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
