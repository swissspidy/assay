import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
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

/** Digest of a snapshot, excluding the capture timestamp. */
export function snapshotDigest(snapshot: { capturedAt?: string }): string {
  const { capturedAt: _ignored, ...rest } = snapshot;
  return sha256(canonicalJson(rest));
}

export function checkSetDigest(checkSet: unknown): string {
  return sha256(canonicalJson(checkSet));
}
