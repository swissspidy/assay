/** `assay validate <checks.json...>`: schema, semantic checks, loose-match warnings and the lock state. */
import { existsSync } from 'node:fs';
import { validateCheckSet, type CheckSet, type ValidationReport } from '../../index.ts';
import { lockState, type LockCheckOptions } from '../../verifier/lock.ts';
import { CliError, EXIT, paint, readText, type Invocation, type Io } from '../io.ts';
import { trustedKeys } from '../keys.ts';

type LockInfo = NonNullable<ReturnType<typeof lockState>['locked']>;

interface FileResult extends ValidationReport {
  file: string;
  checkSet?: { id: string; version: string; requirements: number; checks: number };
  lock?: LockInfo | 'none' | 'broken';
  /** Why the lock is broken. */
  lockProblems?: string[];
  /** Set by --require-locked / --require-signed: why the set is not accepted. */
  notAccepted?: string;
}

function validateFile(file: string, opts: LockCheckOptions): FileResult {
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
  const lock = lockState(cs, opts);
  return {
    file,
    ...report,
    checkSet: { id: cs.id, version: cs.version, requirements: cs.requirements.length, checks: cs.checks.length },
    lock: lock.locked ?? (lock.broken ? 'broken' : 'none'),
    ...(lock.broken ? { lockProblems: lock.problems } : {}),
  };
}

/** Why a valid set does not meet --require-locked / --require-signed, if it does not. */
function notAccepted(r: FileResult, signed: boolean): string | undefined {
  if (r.lock === 'none') return 'not locked';
  if (r.lock === 'broken') return 'lock broken';
  if (signed && r.lock?.signature?.status !== 'trusted')
    return r.lock?.signature ? `signed with key ${r.lock.signature.keyId}, which is not trusted` : 'not signed';
  return undefined;
}

function describeLock(r: FileResult, color: boolean): string {
  if (r.lock === 'none') return 'not locked';
  if (r.lock === 'broken')
    return paint(color, 'red', `lock BROKEN (${r.lockProblems?.join('; ') || 'edited after locking'})`);
  const l = r.lock!;
  const sig = l.signature;
  const signed = !sig
    ? ''
    : sig.status === 'trusted'
      ? `, signed by trusted key ${sig.signer}`
      : sig.status === 'untrusted'
        ? `, signed with untrusted key ${sig.keyId}`
        : `, signed with key ${sig.keyId}`;
  return `locked by ${l.by} at ${l.at}${signed}`;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  for (const f of positionals) if (!existsSync(f)) throw new CliError(`check set not found: ${f}`);
  const keys = trustedKeys(values, io.env);
  const signed = !!values['require-signed'];
  if (signed && !keys)
    throw new CliError(
      '--require-signed needs the trusted public keys: --trusted-key <file|dir> or $ASSAY_TRUSTED_KEYS',
    );
  const results = positionals.map((f) => {
    const r = validateFile(f, keys ? { trustedKeys: keys } : {});
    const why = r.ok && (signed || values['require-locked']) ? notAccepted(r, signed) : undefined;
    return why ? { ...r, notAccepted: why } : r;
  });
  const bad = (r: FileResult) => !r.ok || !!r.notAccepted || (!!values.strict && r.warnings.length > 0);
  if (values.json) {
    io.out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  } else {
    for (const r of results) {
      if (!r.ok) {
        io.out(`${paint(io.color, 'red', '✘')} ${r.file}: invalid`);
      } else {
        const c = r.checkSet!;
        const lock = describeLock(r, io.color);
        const icon = r.notAccepted
          ? paint(io.color, 'red', '✘')
          : r.warnings.length
            ? paint(io.color, 'yellow', '!')
            : paint(io.color, 'green', '✔');
        io.out(
          `${icon} ${r.file}: valid (${c.id} v${c.version}, ${plural(c.requirements, 'requirement')}, ${plural(c.checks, 'check')}, ${lock})`,
        );
      }
      if (r.notAccepted)
        io.out(
          `    ${paint(io.color, 'red', 'error:')} ${r.notAccepted} (${signed ? '--require-signed' : '--require-locked'})`,
        );
      for (const e of r.errors) io.out(`    ${paint(io.color, 'red', 'error:')} ${e}`);
      for (const w of r.warnings) io.out(`    ${paint(io.color, 'yellow', 'warning:')} ${w}`);
    }
  }
  return results.some(bad) ? EXIT.fail : EXIT.ok;
}
