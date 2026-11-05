/** `assay validate <checks.json...>`: schema, semantic checks, loose-match warnings and the lock state. */
import { existsSync } from 'node:fs';
import { validateCheckSet, type CheckSet, type ValidationReport } from '../../index.ts';
import { lockState } from '../../verifier/lock.ts';
import { CliError, EXIT, paint, readText, type Invocation, type Io } from '../io.ts';

interface FileResult extends ValidationReport {
  file: string;
  checkSet?: { id: string; version: string; requirements: number; checks: number };
  lock?: { by: string; at: string } | 'none' | 'broken';
}

function validateFile(file: string): FileResult {
  let input: unknown;
  try {
    input = JSON.parse(readText(file, 'check set'));
  } catch (e) {
    if (e instanceof CliError) throw e;
    return { file, ok: false, errors: [`not valid JSON: ${(e as Error).message}`], warnings: [] };
  }
  const report = validateCheckSet(input);
  if (!report.ok) return { file, ...report };
  const cs = input as CheckSet;
  const lock = lockState(cs);
  return {
    file,
    ...report,
    checkSet: { id: cs.id, version: cs.version, requirements: cs.requirements.length, checks: cs.checks.length },
    lock: lock.locked ?? (lock.broken ? 'broken' : 'none'),
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  for (const f of positionals) if (!existsSync(f)) throw new CliError(`check set not found: ${f}`);
  const results = positionals.map(validateFile);
  const bad = (r: FileResult) => !r.ok || (!!values.strict && r.warnings.length > 0);
  if (values.json) {
    io.out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  } else {
    for (const r of results) {
      if (!r.ok) {
        io.out(`${paint(io.color, 'red', '✘')} ${r.file}: invalid`);
      } else {
        const c = r.checkSet!;
        const lock =
          r.lock === 'none'
            ? 'not locked'
            : r.lock === 'broken'
              ? paint(io.color, 'red', 'lock BROKEN (edited after locking)')
              : `locked by ${r.lock!.by} at ${r.lock!.at}`;
        const icon = r.warnings.length ? paint(io.color, 'yellow', '!') : paint(io.color, 'green', '✔');
        io.out(
          `${icon} ${r.file}: valid (${c.id} v${c.version}, ${plural(c.requirements, 'requirement')}, ${plural(c.checks, 'check')}, ${lock})`,
        );
      }
      for (const e of r.errors) io.out(`    ${paint(io.color, 'red', 'error:')} ${e}`);
      for (const w of r.warnings) io.out(`    ${paint(io.color, 'yellow', 'warning:')} ${w}`);
    }
  }
  return results.some(bad) ? EXIT.fail : EXIT.ok;
}
