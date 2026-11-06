/** `assay stress <checks.json> --reference <snapshot|dir>`: variants and mutants of correct runs. */
import { CheckSetError, assertValidCheckSet, type CheckSet } from '../../index.ts';
import { formatStressReport, stressTest, type StressReport } from '../../stress/index.ts';
import {
  CliError,
  EXIT,
  UsageError,
  list,
  paint,
  readCheckSetFile,
  readSnapshots,
  toSnapshot,
  type Invocation,
  type Io,
} from '../io.ts';
import { cliConfig } from '../config.ts';

/** The findings that make the command fail: everything but advisories and untested checks. */
export function problems(r: StressReport): string[] {
  const out: string[] = [];
  const add = (n: number, what: string) => n && out.push(`${n} ${what}`);
  // A correct run the checks do not pass. Its failing checks also count as over-constrained or
  // fragile, but one that abstains without a check (an uncovered requirement) names none.
  add(r.variants.filter((v) => v.id === 'reference' && !v.accepted).length, 'reference run(s) not passed');
  add(r.overConstrained.length, 'over-constrained');
  add(r.fragile.length, 'fragile');
  add(r.weak.length, 'weak');
  add(r.missed.length, 'missed mutant(s)');
  return out;
}

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const [file] = positionals as [string];
  const paths = (values.reference as string[] | undefined) ?? [];
  if (!paths.length) throw new UsageError('missing --reference <snapshot|dir> (a correct run)');
  let cs: CheckSet;
  try {
    cs = assertValidCheckSet(await readCheckSetFile(file));
  } catch (e) {
    if (e instanceof CheckSetError) throw new CliError(`${file}: ${e.message}`);
    throw e;
  }
  const refs = paths
    .flatMap(readSnapshots)
    .filter((f) => f.expected !== 'fail')
    .map((f) => ({ name: f.name, snapshot: toSnapshot(f) }));
  const dup = refs.find((r, i) => refs.findIndex((x) => x.name === r.name) !== i);
  if (dup) throw new CliError(`two references are named "${dup.name}"`);
  if (!refs.length) throw new CliError('no correct reference run (runs labelled "fail" are skipped)');

  // Flags win over the config's `stress` defaults.
  const defaults = (await cliConfig(values, io)).config.stress ?? {};
  const skip = values['skip-variants'] as string | undefined;
  const claims = (values.claims as boolean | undefined) ?? defaults.successClaims;
  const report = stressTest(cs, refs, {
    skipVariants: skip !== undefined ? list(skip) : (defaults.skipVariants ?? []),
    ...(claims === false ? { successClaims: false } : {}),
  });
  const found = problems(report);
  if (values.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatStressReport(report));
    io.out(
      '\n' +
        (found.length
          ? `${paint(io.color, 'red', '✘')} Problems: ${found.join(', ')}`
          : `${paint(io.color, 'green', '✔')} No problems found.`),
    );
  }
  return found.length ? EXIT.fail : EXIT.ok;
}
