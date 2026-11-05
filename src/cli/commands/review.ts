/** `assay review <checks.json>`: every check in plain language next to what it tests. */
import { CheckSetError, assertValidCheckSet, describeAssertion, reviewSheet, type CheckSet } from '../../index.ts';
import { lockState } from '../../verifier/lock.ts';
import { CliError, EXIT, readJson, type Invocation, type Io } from '../io.ts';

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const [file] = positionals as [string];
  let cs: CheckSet;
  try {
    cs = assertValidCheckSet(readJson(file, 'check set'));
  } catch (e) {
    if (e instanceof CheckSetError) throw new CliError(`${file}: ${e.message}`);
    throw e;
  }
  if (!values.json) {
    io.out(reviewSheet(cs));
    return EXIT.ok;
  }
  const lock = lockState(cs);
  io.out(
    JSON.stringify(
      {
        id: cs.id,
        version: cs.version,
        task: cs.task,
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
              ...(c.onFail ? { onFail: c.onFail } : {}),
            })),
        })),
        lock: lock.locked ?? (lock.broken ? 'broken' : null),
      },
      null,
      2,
    ),
  );
  return EXIT.ok;
}
