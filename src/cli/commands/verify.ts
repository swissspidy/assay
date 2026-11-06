/** `assay verify <checks.json> <snapshot.json>`: run a check set, optionally escalating. */
import {
  CheckSetError,
  evaluate,
  formatOutcome,
  validateCheckSet,
  verify,
  type CheckSet,
  type EvidenceSnapshot,
  type Verdict,
} from '../../index.ts';
import { selectRequirement } from '../../verifier/escalate.ts';
import { assertLocked } from '../../verifier/lock.ts';
import {
  CliError,
  EXIT,
  colorReport,
  readCheckSetFile,
  readSnapshotFile,
  toSnapshot,
  type Invocation,
  type Io,
} from '../io.ts';
import { selectModel } from '../model.ts';
import { trustedKeys } from '../keys.ts';
import { cliConfig } from '../config.ts';

/** Whether `verify` with this policy would escalate a requirement (the checks are validated by it later). */
function escalates(
  checks: unknown,
  snapshot: EvidenceSnapshot,
  given: { on?: ('abstain' | 'fail')[]; includeSoft?: boolean } = {},
): boolean {
  if (!validateCheckSet(checks).ok) return false;
  const cs = checks as CheckSet;
  const outcome = evaluate(cs, snapshot);
  const policy = { on: given.on ?? ['abstain' as const], includeSoft: given.includeSoft ?? false };
  return cs.requirements.some((r) => {
    const sel = selectRequirement(cs, r, outcome, policy);
    return sel === 'policy' || sel === 'onFail';
  });
}

export const exitCodeFor = (verdict: Verdict): number =>
  verdict === 'success' ? EXIT.ok : verdict === 'fail' ? EXIT.fail : EXIT.inconclusive;

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const [checksPath, snapshotPath] = positionals as [string, string];
  const checks = await readCheckSetFile(checksPath);
  const snapshot = toSnapshot(readSnapshotFile(snapshotPath));
  const loaded = await cliConfig(values, io);
  const { config } = loaded;
  const keys = trustedKeys(values, io.env, config);
  // Flags win over the config: --no-require-locked turns off the config's requireLocked.
  const signed =
    values['require-signed'] ?? (values['require-locked'] === false ? false : config.requireLocked === 'signed');
  if (signed && !keys)
    throw new CliError(
      '--require-signed needs the trusted public keys: --trusted-key <file|dir>, $ASSAY_TRUSTED_KEYS or `trustedKeys` in the config',
    );
  // With trusted keys, the record shows whether the lock's signature is trusted; --require-signed demands it.
  const requireLocked = signed
    ? { trustedKeys: keys! }
    : ((values['require-locked'] as boolean | undefined) ?? config.requireLocked === true);
  // The lock is enforced before anything else, so a missing model key cannot hide a refused lock.
  if (requireLocked && validateCheckSet(checks).ok) assertLocked(checks as CheckSet, requireLocked);
  const escalate = (values.escalate as boolean | undefined) ?? !!config.escalate;
  const policy = typeof config.escalate === 'object' ? config.escalate : undefined;
  // The model is selected (and a key needed) only when a requirement will actually escalate.
  const verifier =
    escalate && escalates(checks, snapshot, policy) ? await selectModel(values, io.env, loaded, 'verify') : undefined;
  const recordDir = typeof values.record === 'string' ? values.record : config.recordDir;

  let res: Awaited<ReturnType<typeof verify>>;
  try {
    res = await verify(checks, snapshot, {
      // Everything the config sets is resolved above, with the flags.
      config: false,
      ...(verifier ? { verifier: verifier.model } : {}),
      ...(policy ? { policy } : {}),
      ...(requireLocked ? { requireLocked } : {}),
      ...(keys ? { trustedKeys: keys } : {}),
      ...(typeof values['agent-report'] === 'string' ? { agentReport: values['agent-report'] } : {}),
      ...(recordDir !== undefined ? { recordDir } : {}),
    });
  } catch (e) {
    if (e instanceof CheckSetError) throw new CliError(`${checksPath}: ${e.message}`);
    throw e;
  }
  verifier?.save();

  const { outcome, record, written } = res;
  const code = exitCodeFor(outcome.verdict);
  if (values.json) {
    io.out(
      JSON.stringify(
        {
          verdict: outcome.verdict,
          exitCode: code,
          outcome,
          ...(record.escalation ? { checksOutcome: res.checksOutcome, escalation: record.escalation } : {}),
          ...(written ? { written } : {}),
        },
        null,
        2,
      ),
    );
    return code;
  }
  io.out(colorReport(io.color, formatOutcome(outcome)));
  const esc = record.escalation;
  if (esc?.requirements.length) {
    io.out(
      `Escalated ${esc.requirements.join(', ')} to ${esc.model}: ${esc.status}${esc.error ? ` (${esc.error})` : ''}`,
    );
  } else if (escalate) {
    io.out('Nothing to escalate.');
  }
  if (written) io.out(`Record: ${written.recordFile}`);
  return code;
}
