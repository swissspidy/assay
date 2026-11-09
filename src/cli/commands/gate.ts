/**
 * `assay gate`: the agent regression gate for CI (ADR 0021). Verifies the baseline and the
 * candidate runs with the same check sets (no model) and exits 1 when a task or requirement
 * regressed. Flags win over the config's `gate`, which wins over the defaults.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gate, GateError, type GateResult } from '../../gate/gate.ts';
import { formatGate, formatGateMarkdown, gateJson } from '../../gate/format.ts';
import { cliConfig } from '../config.ts';
import { CliError, EXIT, UsageError, type Invocation, type Io } from '../io.ts';

const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
const listOf = (v: string | string[] | undefined) => (v === undefined ? undefined : typeof v === 'string' ? [v] : v);

function number(v: string | undefined, flag: string, integer: boolean): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  const ok = integer ? Number.isInteger(n) && n >= 1 : Number.isFinite(n) && n >= 0 && v.trim() !== '';
  if (!ok)
    throw new UsageError(
      `${flag} must be ${integer ? 'a positive integer' : 'a number of runs, 0 or more'}, got ${JSON.stringify(v)}`,
    );
  return n;
}

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const loaded = await cliConfig(values, io);
  const { config } = loaded;
  const g = config.gate ?? {};
  const base = loaded.path ? dirname(loaded.path) : cwd;

  // Paths from flags and arguments go to gate() as given: it resolves them against `cwd` and
  // keeps that prefix literal in a glob (a directory named `project[1]`).
  const flagged = (k: string) => {
    const v = values[k] as string[] | undefined;
    return v?.length ? v : undefined;
  };
  const baseline = flagged('baseline') ?? listOf(g.baseline);
  const candidate = flagged('candidate') ?? listOf(g.candidate);
  if (!baseline || !candidate)
    throw new UsageError(
      `missing --${!baseline ? 'baseline' : 'candidate'} <dir|glob> (or \`gate.${!baseline ? 'baseline' : 'candidate'}\` in assay.config.ts)`,
    );
  const checks = positionals.length ? positionals : (g.checks ?? config.checks);
  const tolerance = number(str(values.tolerance), '--tolerance', false) ?? g.tolerance ?? 0;
  const minRuns = number(str(values['min-runs']), '--min-runs', true) ?? g.minRuns ?? 1;
  const allowFlag = values.allow as string[] | undefined;
  const allow = allowFlag?.length ? allowFlag : (g.allow ?? []);

  let result: GateResult;
  try {
    result = await gate({
      baseline,
      candidate,
      ...(checks !== undefined ? { checks } : {}),
      tolerance,
      minRuns,
      allow,
      cwd,
      relativeTo: base,
    });
  } catch (e) {
    if (e instanceof GateError) throw new CliError(e.message);
    throw e;
  }

  const markdown = str(values.markdown);
  if (markdown) {
    const file = resolve(cwd, markdown);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, formatGateMarkdown(result));
  }
  io.out(values.json ? gateJson(result) : formatGate(result, io.color));
  if (markdown) io.err(`Wrote ${markdown}`);
  return result.ok ? EXIT.ok : EXIT.fail;
}
