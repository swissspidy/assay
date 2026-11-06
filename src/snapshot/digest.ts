import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).toSorted()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function sha256(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}

/** Digest of a snapshot, excluding the capture timestamps (of the snapshot and of its baseline). */
export function snapshotDigest(snapshot: { capturedAt?: string; baseline?: { capturedAt?: string } }): string {
  const { capturedAt: _ignored, ...rest } = snapshot;
  if (rest.baseline) {
    const { capturedAt: _also, ...baseline } = rest.baseline;
    return sha256(canonicalJson({ ...rest, baseline }));
  }
  return sha256(canonicalJson(rest));
}

/**
 * What a snapshot looked like when its digest was taken at capture time: its top-level
 * fields in order, and the fields of its small sections (the page, the baseline, meta).
 */
interface Seal {
  digest: string;
  keys: string[];
  values: unknown[];
  inner: Map<string, { keys: string[]; values: unknown[] }>;
}

const seals = new WeakMap<object, Seal>();
/** Sections whose own fields are sealed too: a write to `snapshot.page.url` replaces nothing above it. */
const SEALED_INNER = ['page', 'baseline', 'meta'];

const fields = (o: object) => {
  const keys = Object.keys(o);
  return { keys, values: keys.map((k) => (o as Record<string, unknown>)[k]) };
};

function matches(o: object, f: { keys: string[]; values: unknown[] }): boolean {
  const keys = Object.keys(o);
  if (keys.length !== f.keys.length) return false;
  for (let i = 0; i < keys.length; i++)
    if (keys[i] !== f.keys[i] || (o as Record<string, unknown>)[keys[i]!] !== f.values[i]) return false;
  return true;
}

/**
 * Take a snapshot's digest at capture time (ADR 0016) and remember it for this object:
 * `capturedDigest` returns it later instead of computing it again, unless the snapshot's
 * fields were replaced since. Returns the digest.
 */
export function sealDigest(snapshot: { capturedAt?: string; baseline?: { capturedAt?: string } }): string {
  const digest = snapshotDigest(snapshot);
  const inner = new Map<string, { keys: string[]; values: unknown[] }>();
  for (const k of SEALED_INNER) {
    const v = (snapshot as Record<string, unknown>)[k];
    if (v && typeof v === 'object') inner.set(k, fields(v));
  }
  seals.set(snapshot, { digest, ...fields(snapshot), inner });
  return digest;
}

/**
 * The digest `sealDigest` took of this snapshot object at capture time, when the object
 * still has the same fields, with the same values (by identity), at its top level and in
 * its page, baseline and meta. Undefined otherwise (a parsed or copied snapshot, or one
 * whose fields were replaced): compute `snapshotDigest` instead. Edits deep inside a
 * section (an entry of the network log, a node of the tree) are not seen here; a captured
 * snapshot is not edited in place (ADR 0015), and `writeOutcomeRecord` recomputes the
 * digest before it stores anything.
 */
export function capturedDigest(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const seal = seals.get(snapshot);
  if (!seal || !matches(snapshot, seal)) return undefined;
  for (const [k, f] of seal.inner) {
    const v = (snapshot as Record<string, unknown>)[k];
    if (!v || typeof v !== 'object' || !matches(v, f)) return undefined;
  }
  return seal.digest;
}

export function checkSetDigest(checkSet: unknown): string {
  return sha256(canonicalJson(checkSet));
}
