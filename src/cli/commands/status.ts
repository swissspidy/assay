/** `assay status [checks...]`: the readiness ladder of every task (ADR 0022). */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATUS_STAGES, reached, status, type StatusStage } from '../../status/status.ts';
import { formatStatus } from '../../status/format.ts';
import { CliError, EXIT, UsageError, type Invocation, type Io } from '../io.ts';
import { cliConfig } from '../config.ts';
import { trustedKeys } from '../keys.ts';

const isStage = (s: string): s is StatusStage => (STATUS_STAGES as readonly string[]).includes(s);

/** Run `assay status`: print the ladder, and with `--stage` exit 1 unless every task got through it. */
export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const { config } = await cliConfig(values, io);
  if (!positionals.length && !config.checks)
    throw new UsageError(
      'missing argument: check set files or directories, or `checks` in assay.config.ts (usage: assay status [checks...])',
    );
  const gate = values.stage as string | undefined;
  if (gate !== undefined && !isStage(gate))
    throw new UsageError(`--stage must be one of ${STATUS_STAGES.join(', ')}, got ${JSON.stringify(gate)}`);
  // Flags win over the config: --no-stress drops the stage, --stress adds it back.
  const stages = new Set(config.status?.stages ?? STATUS_STAGES);
  if (values.stress === false) stages.delete('stress');
  if (values.stress === true) stages.add('stress');
  if (gate && !stages.has(gate))
    throw new UsageError(
      `--stage ${gate}: that stage is not evaluated (${gate === 'stress' && values.stress === false ? '--no-stress' : '`status.stages` in the config'})`,
    );
  if (gate === 'recent' && !config.snapshots)
    throw new UsageError('--stage recent: there are no recent runs without `snapshots` in the config');
  const refs = (values.reference as string[] | undefined)?.map((r) => resolve(cwd, r));
  for (const r of refs ?? []) if (!existsSync(r)) throw new CliError(`run directory not found: ${r}`);
  const keys = trustedKeys(values, io.env, config);

  let result;
  try {
    result = await status({
      cwd,
      config,
      ...(positionals.length ? { checks: positionals } : {}),
      ...(refs ? { references: refs } : {}),
      ...(keys ? { trustedKeys: keys } : {}),
      stages: STATUS_STAGES.filter((s) => stages.has(s)),
    });
  } catch (e) {
    if (e instanceof Error && /^(check set not found|no check sets)/.test(e.message)) throw new CliError(e.message);
    throw e;
  }
  io.out(values.json ? JSON.stringify(result, null, 2) : formatStatus(result, { color: io.color }));
  if (gate && result.tasks.some((t) => !reached(t, gate))) return EXIT.fail;
  return EXIT.ok;
}
