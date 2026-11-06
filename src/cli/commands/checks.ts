/**
 * `assay checks print <checks> [--ts]`: a check set as JSON, or as builder TypeScript whose
 * default export is deep-equal to it (ADR 0019).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CheckSetError, assertValidCheckSet, type CheckSet } from '../../index.ts';
import { printCheckSet } from '../../checks/print.ts';
import { CliError, EXIT, UsageError, readCheckSetFile, type Invocation, type Io } from '../io.ts';

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const [sub, file] = positionals as [string, string];
  if (sub !== 'print') throw new UsageError(`unknown subcommand "${sub}" (usage: assay checks print <checks> [--ts])`);
  if (values.json && values.ts) throw new UsageError('--ts and --json cannot be combined');
  let cs: CheckSet;
  try {
    cs = assertValidCheckSet(await readCheckSetFile(file));
  } catch (e) {
    if (e instanceof CheckSetError) throw new CliError(`${file}: ${e.message}`);
    throw e;
  }
  const text = values.ts
    ? printCheckSet(cs, typeof values.import === 'string' ? { importFrom: values.import } : {})
    : JSON.stringify(cs, null, 2) + '\n';
  const out = values.out as string | undefined;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    io.err(`Wrote ${out}`);
  } else io.out(text.replace(/\n$/, ''));
  return EXIT.ok;
}
