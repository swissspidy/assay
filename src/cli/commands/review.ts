/**
 * `assay review <checks.json>`: the review sheet, every check in plain language next to
 * what it tests; with `--diff`, what changed since the approved version (ADR 0013).
 */
import {
  describeAssertion,
  diffCheckSets,
  evidenceRead,
  reviewSheet,
  reviewState,
  validateCheckSet,
  type CheckSet,
} from '../../index.ts';
import type { StressReport } from '../../stress/index.ts';
import { lockState } from '../../verifier/lock.ts';
import { checkSettings } from '../../verifier/diff.ts';
import { CliError, EXIT, UsageError, readJson, type Invocation, type Io } from '../io.ts';
import { readCheckSet, trustedKeys } from '../keys.ts';

const FORMATS = ['markdown', 'github', 'html'] as const;

function readStress(file: string): StressReport {
  const r = readJson(file, 'stress report') as Partial<StressReport> | null;
  if (!r || typeof r !== 'object' || !r.checkSet || !r.rates || !Array.isArray(r.weak))
    throw new CliError(`${file} is not a stress report (assay stress --json)`);
  return r as StressReport;
}

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const [file] = positionals as [string];
  const format = (values.format as string | undefined) ?? 'markdown';
  if (!(FORMATS as readonly string[]).includes(format))
    throw new UsageError(`--format must be one of ${FORMATS.join(', ')}`);
  const cs = readCheckSet(file);
  const previous: CheckSet | undefined =
    typeof values.diff === 'string' ? readCheckSet(values.diff, 'previous check set') : undefined;
  const stress = typeof values.stress === 'string' ? readStress(values.stress) : undefined;
  const keys = trustedKeys(values, io.env);
  const opts = keys ? { trustedKeys: keys } : {};

  if (!values.json) {
    io.out(
      reviewSheet(cs, {
        ...opts,
        format: format === 'html' ? 'html' : 'markdown',
        details: format === 'github',
        ...(previous ? { previous } : {}),
        ...(stress ? { stress } : {}),
      }),
    );
    return EXIT.ok;
  }
  const lock = lockState(cs, opts);
  const state = reviewState(cs, opts);
  io.out(
    JSON.stringify(
      {
        id: cs.id,
        version: cs.version,
        task: cs.task,
        state: state.state,
        requirements: cs.requirements.map((r) => ({
          id: r.id,
          kind: r.kind,
          text: r.text,
          quote: r.source.quote,
          checks: cs.checks
            .filter((c) => c.requirement === r.id)
            .map((c) => ({
              id: c.id,
              description: c.description,
              tests: describeAssertion(c.assert),
              reads: evidenceRead(c.assert),
              ...(c.onFail ? { onFail: c.onFail } : {}),
              ...(c.onMissing ? { onMissing: c.onMissing } : {}),
              settings: checkSettings(c),
            })),
        })),
        warnings: validateCheckSet(cs).warnings,
        lock: lock.locked ?? (lock.broken ? 'broken' : null),
        ...(lock.broken ? { lockProblems: lock.problems, changes: state.lock.changes } : {}),
        ...(state.rejected ? { rejected: state.rejected } : {}),
        ...(previous ? { diff: diffCheckSets(previous, cs) } : {}),
      },
      null,
      2,
    ),
  );
  return EXIT.ok;
}
