/** `assay validate <checks.json...>`: schema, semantic checks, loose-match warnings and the lock state. */
import { existsSync, globSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateCheckSet, type CheckSet, type ValidationReport } from '../../index.ts';
import { lockState, type LockCheckOptions } from '../../verifier/lock.ts';
import { CliError, EXIT, UsageError, paint, type Invocation, type Io } from '../io.ts';
import { CHECK_SET_GLOBS, CheckSetFileError, loadCheckSetFile } from '../../checks/load.ts';
import { cliConfig } from '../config.ts';
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

async function validateFile(file: string, opts: LockCheckOptions): Promise<FileResult> {
  let input: unknown;
  try {
    input = await loadCheckSetFile(file);
  } catch (e) {
    // A file that cannot be read is an error; one that does not parse or load is invalid.
    if (!(e instanceof CheckSetFileError) || (e.code !== 'EJSON' && e.code !== 'ELOAD')) {
      throw e instanceof CheckSetFileError ? new CliError(e.message) : e;
    }
    const why = e.code === 'EJSON' ? e.message.replace(/^check set .* is not valid JSON/, 'not valid JSON') : e.message;
    return { file, ok: false, errors: [why], warnings: [] };
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

/**
 * The check set files the config's `checks` names: a directory (every `*.checks.json` and
 * `*.checks.ts` under it) or a glob.
 */
export function configuredChecks(checks: string): string[] {
  // A path that exists is literal, even when its name has glob characters (`project[abc]`).
  let files: string[];
  if (existsSync(checks)) {
    files = statSync(checks).isDirectory()
      ? CHECK_SET_GLOBS.flatMap((g) => globSync(g, { cwd: checks })).map((f) => join(checks, f))
      : [checks];
  } else files = globSync(checks);
  files = files.toSorted();
  if (!files.length) throw new CliError(`no check sets match \`checks\` in the config: ${checks}`);
  return files;
}

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const { config } = await cliConfig(values, io);
  if (!positionals.length && !config.checks)
    throw new UsageError(
      'missing argument: the check set files, or `checks` in assay.config.ts (usage: assay validate [checks.json|checks.ts...])',
    );
  const files = positionals.length ? positionals : configuredChecks(config.checks!);
  for (const f of files) if (!existsSync(f)) throw new CliError(`check set not found: ${f}`);
  const keys = trustedKeys(values, io.env, config);
  // Flags win over the config: --no-require-locked turns off the config's requireLocked.
  const signed =
    (values['require-signed'] as boolean | undefined) ??
    (values['require-locked'] === false ? false : config.requireLocked === 'signed');
  const locked = (values['require-locked'] as boolean | undefined) ?? !!config.requireLocked;
  if (signed && !keys)
    throw new CliError(
      '--require-signed needs the trusted public keys: --trusted-key <file|dir>, $ASSAY_TRUSTED_KEYS or `trustedKeys` in the config',
    );
  const results: FileResult[] = [];
  for (const f of files) {
    const r = await validateFile(f, keys ? { trustedKeys: keys } : {});
    const why = r.ok && (signed || locked) ? notAccepted(r, signed) : undefined;
    results.push(why ? { ...r, notAccepted: why } : r);
  }
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
