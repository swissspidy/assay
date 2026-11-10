/**
 * Scoped snapshots (ADR 0025): a snapshot that keeps only what one check set's plan reads
 * (ADR 0015 read-sets), marked as scoped and tied to that check set's content digest. It is
 * evidence for that check set alone: `verify` with that set gives the outcome the full
 * snapshot gives; anything else (another check set, escalation, stress, compiling) refuses it.
 */
import {
  SCOPED_SNAPSHOT_SCHEMA,
  SNAPSHOT_SCHEMA,
  type CheckSet,
  type EvidenceSnapshot,
  type Outcome,
  type ScopedSnapshot,
  type StorageRecord,
} from '../types.ts';
import { compileChecks } from '../plan/plan.ts';
import { readKeys, type ReadSet } from '../plan/readset.ts';
import { matchRequest } from '../runtime/network.ts';
import { contentDigest } from '../verifier/lock.ts';
import { snapshotDigest } from './digest.ts';

/** A scoped snapshot used where it cannot be: with another check set, or for what needs the full page. */
export class ScopedSnapshotError extends Error {
  override readonly name = 'ScopedSnapshotError';
}

export const isScoped = (s: unknown): s is ScopedSnapshot =>
  !!s && typeof s === 'object' && (s as { schema?: unknown }).schema === SCOPED_SNAPSHOT_SCHEMA;

const describeScope = (s: ScopedSnapshot) =>
  `a scoped snapshot (${SCOPED_SNAPSHOT_SCHEMA}) for check set ${s.scope.checkSet.id} v${s.scope.checkSet.version}`;

/**
 * Throws when `s` is a scoped snapshot: `what` needs the full evidence (the whole page, every
 * request), which a scoped snapshot left out.
 */
export function assertFullSnapshot(s: unknown, what: string): void {
  if (isScoped(s))
    throw new ScopedSnapshotError(
      `${what} needs a full snapshot, but this is ${describeScope(s)}: it holds only what that check set reads. Capture a full snapshot (captureSnapshot) for it.`,
    );
}

/** What a check set reads, for scoping: its plan's read-set and read keys, and its content digest. */
export interface ScopePlan {
  checkSet: CheckSet;
  readSet: ReadSet;
  reads: string[];
  content: string;
}

const plans = new WeakMap<object, ScopePlan>();

/**
 * The scope of a valid check set (throws `CheckSetError` otherwise). A check that reads
 * something its read-set cannot describe (opaque) cannot be scoped.
 */
export function scopePlan(checkSet: CheckSet | unknown): ScopePlan {
  const cached = checkSet && typeof checkSet === 'object' ? plans.get(checkSet) : undefined;
  if (cached) return cached;
  const plan = compileChecks(checkSet);
  const cs = plan.assertValid();
  const keys = readKeys(plan.readSet);
  if (!keys) throw new ScopedSnapshotError(`check set ${cs.id} has a check whose reads cannot be described`);
  const p: ScopePlan = { checkSet: cs, readSet: plan.readSet, reads: [...keys].toSorted(), content: contentDigest(cs) };
  plans.set(cs, p);
  return p;
}

const pick = <T>(o: Record<string, T>, names: Iterable<string>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const n of names) if (Object.prototype.hasOwnProperty.call(o, n)) out[n] = o[n]!;
  return out;
};

/** The keys `names` of every origin's web storage; origins left with none are left out. */
function storageArea(byOrigin: StorageRecord['local'], names: Set<string>): StorageRecord['local'] {
  const out: StorageRecord['local'] = {};
  for (const [origin, kv] of Object.entries(byOrigin)) {
    const kept = pick(kv, names);
    if (Object.keys(kept).length) out[origin] = kept;
  }
  return out;
}

/** The storage keys read (cookies by name, web storage by key in every origin). */
function scopeStorage(st: StorageRecord, reads: ReadSet['storage']): StorageRecord {
  const keys = (area: string) => new Set(reads.filter((r) => r.area === area).map((r) => r.key));
  const cookies = keys('cookie');
  return {
    cookies: st.cookies.filter((c) => cookies.has(c.name)),
    local: storageArea(st.local, keys('local')),
    session: storageArea(st.session, keys('session')),
  };
}

/** The sections `prune` scopes by name; any other is kept whole when its read key is read. */
const KNOWN = new Set([
  'schema',
  'capturedAt',
  'page',
  'a11y',
  'text',
  'network',
  'storage',
  'probes',
  'baseline',
  'pages',
  'meta',
  'scope',
]);

/**
 * The parts of `s` its plan reads. Sections outside the read keys are left out; the network
 * log keeps the entries some read request match does not rule out (`yes` or `unknown`), in log
 * order and whole; storage and probes keep the keys and probes read. The page URL and title
 * and the metadata are always kept: the outcome reports the URL.
 */
function prune(s: EvidenceSnapshot, p: ScopePlan, source: string | undefined): ScopedSnapshot {
  const rs = p.readSet;
  const keys = new Set(p.reads);
  const after = rs.storage.filter((r) => r.at === 'after');
  const before = rs.storage.filter((r) => r.at === 'before');
  const probesAfter = rs.probes.filter((r) => r.at === 'after').map((r) => r.probe);
  const probesBefore = rs.probes.filter((r) => r.at === 'before').map((r) => r.probe);
  const out: ScopedSnapshot = {
    schema: SCOPED_SNAPSHOT_SCHEMA,
    capturedAt: s.capturedAt,
    scope: {
      checkSet: { id: p.checkSet.id, version: p.checkSet.version, content: p.content },
      reads: p.reads,
      ...(source !== undefined ? { source } : {}),
    },
    page: s.page,
    meta: s.meta,
  };
  // A section this module does not know (added by a later format) is kept whole when read.
  for (const [k, v] of Object.entries(s))
    if (!KNOWN.has(k) && keys.has(k) && v !== undefined) Object.assign(out, { [k]: v });
  if (keys.has('a11y')) out.a11y = s.a11y;
  if (keys.has('text')) out.text = s.text;
  if (keys.has('pages') && s.pages) out.pages = s.pages;
  if (keys.has('network'))
    out.network = s.network && s.network.filter((e) => rs.requests.some((m) => matchRequest(m, e) !== 'no'));
  if (after.length) out.storage = s.storage && scopeStorage(s.storage, after);
  if (probesAfter.length) out.probes = pick(s.probes, probesAfter);
  if ((before.length || probesBefore.length) && s.baseline) {
    const b = s.baseline;
    out.baseline = {
      capturedAt: b.capturedAt,
      url: b.url,
      ...(before.length ? { storage: b.storage && scopeStorage(b.storage, before) } : {}),
      ...(probesBefore.length ? { probes: pick(b.probes, probesBefore) } : {}),
      redacted: b.redacted,
    };
  }
  return out;
}

/**
 * Derive the scoped snapshot of `checkSet` from a full snapshot: what scoped capture would have
 * recorded of the same run. `scope.source` is the full snapshot's digest.
 */
export function scopeSnapshot(snapshot: EvidenceSnapshot, checkSet: CheckSet | unknown): ScopedSnapshot {
  assertFullSnapshot(snapshot, 'scopeSnapshot');
  return prune(snapshot, scopePlan(checkSet), snapshotDigest(snapshot));
}

/** @internal Scope a snapshot captured with only the read parts filled in (captureScopedSnapshot). */
export const scopeCaptured = (s: EvidenceSnapshot, p: ScopePlan): ScopedSnapshot => prune(s, p, undefined);

/**
 * The evidence of a scoped snapshot for `checkSet`, as the evaluator reads it, and its digest.
 * Throws `ScopedSnapshotError` when the snapshot was scoped to another check set (another
 * content digest). Sections the snapshot left out are filled with empty values the plan never
 * reads (its read-set does not include them).
 */
export function scopedEvidence(
  s: ScopedSnapshot,
  checkSet: CheckSet | unknown,
): { snapshot: EvidenceSnapshot; digest: string } {
  const p = scopePlan(checkSet);
  if (s.scope?.checkSet?.content !== p.content)
    throw new ScopedSnapshotError(
      `this is ${describeScope(s)} (${s.scope?.checkSet?.content}); it holds only what that set reads, so it cannot verify ${p.checkSet.id} v${p.checkSet.version} (${p.content}). Verify it with the set it was scoped to, or capture a full snapshot.`,
    );
  const b = s.baseline;
  const other = Object.fromEntries(Object.entries(s).filter(([k]) => !KNOWN.has(k)));
  const snapshot: EvidenceSnapshot = {
    ...other,
    schema: SNAPSHOT_SCHEMA,
    capturedAt: s.capturedAt,
    page: s.page,
    a11y: s.a11y ?? { role: 'document' },
    text: s.text ?? '',
    network: s.network ?? null,
    storage: s.storage ?? null,
    probes: s.probes ?? {},
    ...(b ? { baseline: { ...b, storage: b.storage ?? null, probes: b.probes ?? {} } } : {}),
    ...(s.pages ? { pages: s.pages } : {}),
    meta: s.meta,
  };
  return { snapshot, digest: snapshotDigest(s) };
}

/** An outcome of a scoped snapshot's evidence, citing the scoped snapshot's digest. */
export const withSnapshotDigest = (o: Outcome, digest: string): Outcome => ({
  ...o,
  snapshot: { ...o.snapshot, digest },
});
