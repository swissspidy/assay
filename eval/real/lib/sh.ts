/** Process and HTTP helpers for driving the real apps (Docker containers). */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ShResult {
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell; rejects with its stderr on a non-zero exit. */
export function sh(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<ShResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 300_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed: ${stderr || err.message}`));
        else resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

export const docker = (...args: string[]) => sh('docker', args);

/** Removes a container if it exists (no error when it does not). */
export async function removeContainer(name: string): Promise<void> {
  await sh('docker', ['rm', '-f', name]).catch(() => undefined);
}

export async function containerRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await docker('inspect', '-f', '{{.State.Running}}', name);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function ensureNetwork(name: string): Promise<void> {
  try {
    await docker('network', 'inspect', name);
  } catch {
    await docker('network', 'create', name);
  }
}

/** Waits until `url` answers with a status below 500 (redirects not followed). */
export async function waitHttp(url: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up within ${ms} ms (${last})`);
}

/** Waits until `fn` resolves without throwing. */
export async function waitFor(what: string, fn: () => Promise<unknown>, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await fn();
      return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} not ready within ${ms} ms: ${last instanceof Error ? last.message : String(last)}`);
}

/** Working directory for container data and pristine copies (not part of the repository). */
export function workDir(...parts: string[]): string {
  const dir = join(process.env.ASSAY_REAL_WORK ?? join(tmpdir(), 'assay-real'), ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Runs SQL in a MariaDB container and returns the rows as objects (tab-separated output parsed). */
export async function mariadbQuery(
  container: string,
  db: string,
  sql: string,
): Promise<Record<string, string | null>[]> {
  const { stdout } = await sh('docker', ['exec', '-i', container, 'mariadb', '-uroot', '-proot', '--batch', db], {
    input: sql,
  });
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  if (!lines.length) return [];
  const cols = lines[0]!.split('\t');
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] === 'NULL' ? null : unescapeCell(cells[i] ?? '')]));
  });
}

/** Undoes the escaping of mariadb's --batch output. */
function unescapeCell(v: string): string {
  return v.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
}

/** Runs SQL that returns one JSON document (e.g. JSON_ARRAYAGG) and parses it; empty result → []. */
export async function mariadbJson<T = unknown>(container: string, db: string, sql: string): Promise<T> {
  const { stdout } = await sh('docker', ['exec', '-i', container, 'mariadb', '-uroot', '-proot', '-N', '--raw', db], {
    input: sql,
  });
  const text = stdout.trim();
  if (!text || text === 'NULL') return [] as T;
  return JSON.parse(text) as T;
}

/** SQL string literal. */
export const sqlStr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
