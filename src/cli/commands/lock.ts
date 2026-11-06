/**
 * `assay approve`, `assay reject` and `assay unlock`: a reviewer's decision on a check set
 * (ADR 0013). Each rewrites the file (or writes `--out`).
 */
import { approveCheckSet, rejectCheckSet, unlockCheckSet, type CheckSet } from '../../index.ts';
import { CliError, EXIT, UsageError, paint, readJson, type Invocation, type Io } from '../io.ts';
import { readCheckSet, signingKey, writeCheckSet } from '../keys.ts';
import { isModuleFile } from '../../checks/load.ts';

function reviewer(values: Invocation['values'], env: Io['env']): string {
  const by = (values.reviewer as string | undefined) ?? env.ASSAY_REVIEWER;
  if (!by?.trim()) throw new UsageError('missing --reviewer <name> (or $ASSAY_REVIEWER)');
  return by;
}

export async function run({ command, values, positionals }: Invocation, io: Io): Promise<number> {
  const [file] = positionals as [string];
  const out = (values.out as string | undefined) ?? file;
  // A module (`*.checks.ts`) is source code: the decision is written as JSON beside it, never over it.
  if (isModuleFile(out))
    throw new UsageError(
      `${out} is a module; ${command} writes the check set as JSON: add --out <file.checks.json> (assay checks print shows the JSON)`,
    );
  const cs = await readCheckSet(file);
  const note = values.note as string | undefined;
  const ok = paint(io.color, 'green', '✔');
  let result: CheckSet;
  let summary: string;

  if (command === 'approve') {
    const by = reviewer(values, io.env);
    const key = signingKey(values, io.env);
    const stress = typeof values.stress === 'string' ? readJson(values.stress, 'stress report') : undefined;
    try {
      result = approveCheckSet(cs, {
        by,
        ...(note ? { note } : {}),
        ...(key ? { key } : {}),
        ...(stress !== undefined ? { stress } : {}),
      });
    } catch (e) {
      throw new CliError(`${file}: ${(e as Error).message}`);
    }
    const sig = result.locked!.signature;
    summary = `${ok} Approved ${cs.id} v${cs.version} as ${by}, ${sig ? `signed with key ${sig.keyId}` : 'unsigned (no --key or $ASSAY_SIGNING_KEY)'}: ${out}`;
  } else if (command === 'reject') {
    const by = reviewer(values, io.env);
    if (!note?.trim()) throw new UsageError('missing --note <text>: say why the set is rejected');
    result = rejectCheckSet(cs, { by, note });
    summary = `${paint(io.color, 'red', '✘')} Rejected ${cs.id} v${cs.version} as ${by}: ${out}`;
  } else {
    const had = cs.locked ? 'lock' : cs.rejected ? 'rejection' : null;
    result = unlockCheckSet(cs);
    summary = had
      ? `${ok} Removed the ${had} of ${cs.id} v${cs.version}; it is a proposal again: ${out}`
      : `${ok} ${cs.id} v${cs.version} was not locked or rejected: ${out}`;
  }

  writeCheckSet(out, result);
  if (values.json) {
    io.out(
      JSON.stringify(
        {
          file: out,
          id: result.id,
          version: result.version,
          state: command === 'approve' ? 'approved' : command === 'reject' ? 'rejected' : 'proposal',
          ...(result.locked ? { lock: result.locked } : {}),
          ...(result.rejected ? { rejected: result.rejected } : {}),
        },
        null,
        2,
      ),
    );
  } else io.out(summary);
  return EXIT.ok;
}
