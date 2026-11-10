/**
 * Stress testing of order (ADR 0024): near misses that reorder a run's trajectory, so a
 * `sequence` check whose steps match too much (an early unrelated request standing in for
 * the step) is reported as weak, and a valid variant that interleaves unrelated events.
 * Variants that rewrite the network log keep the trajectory's request events pointing at
 * the same requests.
 */
import type { Assertion, EvidenceSnapshot, NetworkEntry, TrajectoryEvent } from '../types.ts';
import { sequenceHits } from '../plan/assertions.ts';
import { describeRequestMatch, describeUrlMatch } from '../runtime/network.ts';

type Sequence = Extract<Assertion, { kind: 'sequence' }>;

interface SequenceMutant {
  id: string;
  description: string;
  snapshot: EvidenceSnapshot;
}

const stepName = (step: Sequence['steps'][number]) =>
  'request' in step
    ? `the request ${describeRequestMatch(step.request)}`
    : `the navigation to ${describeUrlMatch(step.url)}`;

/** `events` with the event at `from` moved to index `to` (in the result); times stay at their positions. */
function move(events: TrajectoryEvent[], from: number, to: number): TrajectoryEvent[] {
  const out = events.slice();
  const [e] = out.splice(from, 1);
  out.splice(to, 0, e!);
  return out.map((x, i) => (x === events[i] ? x : { ...x, t: events[i]!.t }));
}

/**
 * Near misses for a `sequence`, made from a snapshot on which it passes:
 * - `swap`: the first events of two adjacent steps trade places (the later step happened first);
 * - `late`: the later step's first event moves just before the last event of the step before
 *   it, where that step occurred more than once before it: a check whose earlier step also
 *   matches an earlier, unrelated event still passes, and is reported as weak;
 * - `interleave` (strict only): an event of a step moves to just after the next step began;
 * - `missing`: a step never happened (its events and, for a request, its network entries gone).
 */
export function sequenceMutants(s: EvidenceSnapshot, a: Sequence): SequenceMutant[] {
  const events = s.trajectory;
  if (!events) return [];
  const hits = sequenceHits(s, a).map((h) => h.yes);
  if (hits.some((h) => h.length === 0)) return [];
  const out: SequenceMutant[] = [];
  const at = (k: number) => (a.steps.length > 2 ? `[${k + 1}]` : '');
  for (let k = 0; k + 1 < a.steps.length; k++) {
    const p = hits[k]![0]!;
    const q = hits[k + 1]![0]!;
    if (p >= q) continue;
    const swapped = events.slice();
    swapped[p] = { ...events[q]!, t: events[p]!.t };
    swapped[q] = { ...events[p]!, t: events[q]!.t };
    out.push({
      id: `sequence:swap${at(k)}`,
      description: `${stepName(a.steps[k + 1]!)} happened before ${stepName(a.steps[k]!)}`,
      snapshot: { ...s, trajectory: swapped },
    });
    const before = hits[k]!.filter((i) => i < q);
    const last = before.at(-1)!;
    if (last !== p)
      out.push({
        id: `sequence:late${at(k)}`,
        description: `${stepName(a.steps[k + 1]!)} happened before the last ${stepName(a.steps[k]!)} preceding it`,
        snapshot: { ...s, trajectory: move(events, q, last) },
      });
    if (a.strict && last !== p)
      out.push({
        id: `sequence:interleave${at(k)}`,
        description: `${stepName(a.steps[k]!)} happened again after ${stepName(a.steps[k + 1]!)} began`,
        snapshot: { ...s, trajectory: move(events, last, q) },
      });
  }
  a.steps.forEach((step, k) => {
    const drop = new Set(hits[k]);
    const trajectory = events.filter((_, i) => !drop.has(i));
    const gone = new Set(
      [...drop].flatMap((i) => {
        const e = events[i]!;
        return e.type === 'request' ? [e.seq] : [];
      }),
    );
    const network = gone.size && s.network ? s.network.filter((e) => !gone.has(e.seq)) : s.network;
    out.push({
      id: `sequence:missing${a.steps.length > 1 ? `[${k + 1}]` : ''}`,
      description: `${stepName(step)} never happened`,
      snapshot: { ...s, network, trajectory },
    });
  });
  return out;
}

/**
 * The trajectory after a variant renumbered the network log: each request event of an old
 * `seq` becomes events for the new seqs it maps to (a retried request: its failed attempt,
 * then itself), at the same time. Undefined when the snapshot has none.
 */
export function remapRequests(
  trajectory: TrajectoryEvent[] | undefined,
  seqs: ReadonlyMap<number, readonly number[]>,
): TrajectoryEvent[] | undefined {
  return trajectory?.flatMap((e) =>
    e.type === 'request' && seqs.has(e.seq) ? seqs.get(e.seq)!.map((seq) => ({ ...e, seq })) : [e],
  );
}

/** The trajectory with request events for entries a variant appended to the log, at its end. */
export function appendRequests(
  trajectory: TrajectoryEvent[] | undefined,
  entries: readonly NetworkEntry[],
): TrajectoryEvent[] | undefined {
  if (!trajectory) return undefined;
  const t = trajectory.at(-1)?.t ?? 0;
  return [...trajectory, ...entries.map((e): TrajectoryEvent => ({ type: 'request', seq: e.seq, t }))];
}

/**
 * Valid variant: an unrelated request (an analytics beacon) between every two events of the
 * trajectory. A sequence does not require its steps to be adjacent, so it must still pass.
 */
export function trajectoryNoise(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const events = s.trajectory;
  if (!events || events.length < 2 || !s.network) return null;
  let origin: string;
  try {
    origin = new URL(s.page.url).origin;
  } catch {
    return null;
  }
  let seq = Math.max(-1, ...s.network.map((e) => e.seq)) + 1;
  const extra: NetworkEntry[] = [];
  const trajectory: TrajectoryEvent[] = [];
  events.forEach((e, i) => {
    trajectory.push(e);
    if (i === events.length - 1) return;
    const entry: NetworkEntry = {
      seq: seq++,
      method: 'POST',
      url: `${origin}/analytics/collect?e=${i}`,
      resourceType: 'beacon',
      status: 204,
      requestHeaders: {},
      responseHeaders: {},
    };
    extra.push(entry);
    trajectory.push({ type: 'request', seq: entry.seq, t: e.t });
  });
  return { ...s, network: [...s.network, ...extra], trajectory };
}
