/** `assay verify <checks.json> <snapshot.json>`: run a check set, optionally escalating. */
import { CheckSetError, formatOutcome, verify, type Verdict } from '../../index.ts';
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

export const exitCodeFor = (verdict: Verdict): number =>
  verdict === 'success' ? EXIT.ok : verdict === 'fail' ? EXIT.fail : EXIT.inconclusive;

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const [checksPath, snapshotPath] = positionals as [string, string];
  const checks = readJson(checksPath, 'check set');
  const snapshot = toSnapshot(readSnapshotFile(snapshotPath));
  const verifier = values.escalate ? await selectModel(values, io.env) : undefined;

  let res: Awaited<ReturnType<typeof verify>>;
  try {
    res = await verify(checks, snapshot, {
      ...(verifier ? { verifier: verifier.model } : {}),
      ...(values['require-locked'] ? { requireLocked: true } : {}),
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
  } else if (verifier) {
    io.out('Nothing to escalate.');
  }
  if (written) io.out(`Record: ${written.recordFile}`);
  return code;
}
