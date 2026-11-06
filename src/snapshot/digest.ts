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

/** Digests taken at capture time, by snapshot object; only snapshots frozen whole are kept. */
const seals = new WeakMap<object, string>();

/**
 * Freeze `value` and every object and array inside it; false, with nothing frozen, when it
 * holds something other than plain objects, arrays and primitives, whose contents freezing
 * would not fix (a Date, a Map, a typed array, an accessor).
 */
function freezeJson(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return false;
      continue;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false;
    // Accessors could compute anything: only data properties.
    for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) {
      if (!('value' in d)) return false;
      stack.push(d.value);
    }
  }
  for (const v of seen) Object.freeze(v);
  return true;
}

/**
 * Take a snapshot's digest at capture time (ADR 0016) and keep it for this object, so that
 * `capturedDigest` returns it later instead of computing it again. The snapshot is frozen,
 * with everything inside it, so the evidence the digest was taken of cannot change: an edit
 * in place throws (in strict mode) instead of leaving a record with a stale digest. A
 * snapshot that holds anything but JSON data is neither frozen whole nor kept. Returns the
 * digest.
 */
export function sealDigest(snapshot: { capturedAt?: string; baseline?: { capturedAt?: string } }): string {
  const digest = snapshotDigest(snapshot);
  if (freezeJson(snapshot)) seals.set(snapshot, digest);
  return digest;
}

/**
 * The digest `sealDigest` took of this snapshot object at capture time, while the object is
 * still frozen (it always is: a frozen object cannot be thawed). Undefined for any other
 * object (a parsed or copied snapshot): compute `snapshotDigest` instead.
 */
export function capturedDigest(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== 'object' || !Object.isFrozen(snapshot)) return undefined;
  return seals.get(snapshot);
}

/** Digest of a check set: SHA-256 of its canonical JSON. */
export function checkSetDigest(checkSet: unknown): string {
  return sha256(canonicalJson(checkSet));
}
