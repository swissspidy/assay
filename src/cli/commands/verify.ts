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
import {
  CliError,
  EXIT,
  colorReport,
  readJson,
  readSnapshotFile,
  toSnapshot,
  type Invocation,
  type Io,
} from '../io.ts';
import { selectModel } from '../model.ts';
import { trustedKeys } from '../keys.ts';

/** Whether `verify` with its default policy would escalate a requirement (the checks are validated by it later). */
function escalates(checks: unknown, snapshot: EvidenceSnapshot): boolean {
  if (!validateCheckSet(checks).ok) return false;
  const cs = checks as CheckSet;
  const outcome = evaluate(cs, snapshot);
  const policy = { on: ['abstain' as const], includeSoft: false };
  return cs.requirements.some((r) => {
    const sel = selectRequirement(cs, r, outcome, policy);
    return sel === 'policy' || sel === 'onFail';
  });
}

export const exitCodeFor = (verdict: Verdict): number =>
  verdict === 'success' ? EXIT.ok : verdict === 'fail' ? EXIT.fail : EXIT.inconclusive;

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const [checksPath, snapshotPath] = positionals as [string, string];
  const checks = readJson(checksPath, 'check set');
  const snapshot = toSnapshot(readSnapshotFile(snapshotPath));
  const keys = trustedKeys(values, io.env);
  if (values['require-signed'] && !keys)
    throw new CliError(
      '--require-signed needs the trusted public keys: --trusted-key <file|dir> or $ASSAY_TRUSTED_KEYS',
    );
  // With trusted keys, the record shows whether the lock's signature is trusted; --require-signed demands it.
  const requireLocked = values['require-signed'] ? { trustedKeys: keys! } : !!values['require-locked'];
  // The model is selected (and a key needed) only when a requirement will actually escalate.
  const verifier = values.escalate && escalates(checks, snapshot) ? await selectModel(values, io.env) : undefined;

  let res: Awaited<ReturnType<typeof verify>>;
  try {
    res = await verify(checks, snapshot, {
      ...(verifier ? { verifier: verifier.model } : {}),
      ...(requireLocked ? { requireLocked } : {}),
      ...(keys ? { trustedKeys: keys } : {}),
      ...(typeof values['agent-report'] === 'string' ? { agentReport: values['agent-report'] } : {}),
      ...(typeof values.record === 'string' ? { recordDir: values.record } : {}),
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
  } else if (values.escalate) {
    io.out('Nothing to escalate.');
  }
  if (written) io.out(`Record: ${written.recordFile}`);
  return code;
}
