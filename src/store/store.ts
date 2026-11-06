/**
 * The evidence store (ADR 0015): one immutable, indexed view of a snapshot, built once per
 * snapshot object and shared by every check, every `verify` call and every check set that
 * reads it.
 */
import type { AXNode, CookieRecord, EvidenceSnapshot, PageView, StorageRecord } from '../types.ts';
import { AXIndex } from '../runtime/axindex.ts';
import { canonicalJson, capturedDigest, sha256, snapshotDigest } from '../snapshot/digest.ts';
import { networkTable, type NetworkTable } from './network.ts';

/** The top-level sections of a snapshot that have their own digest. */
export type Section = Exclude<keyof EvidenceSnapshot, 'capturedAt'>;

export class EvidenceStore {
  readonly snapshot: EvidenceSnapshot;
  private digestValue?: string;
  private sectionDigestsValue?: Readonly<Partial<Record<Section, string>>>;

  constructor(snapshot: EvidenceSnapshot) {
    this.snapshot = snapshot;
  }

  /** The active page's accessibility tree, indexed. */
  get ax(): AXIndex {
    return AXIndex.of(this.snapshot.a11y);
  }

  /** The index of any tree of the snapshot (another open page's). */
  axOf(tree: AXNode): AXIndex {
    return AXIndex.of(tree);
  }

  /** The network log as a table; null when it was not recorded. */
  get network(): NetworkTable | null {
    return this.snapshot.network ? networkTable(this.snapshot.network) : null;
  }

  /** The open pages: the active page first, then the others. */
  get pages(): PageView[] {
    const s = this.snapshot;
    return [{ url: s.page.url, title: s.page.title, a11y: s.a11y, text: s.text }, ...(s.pages ?? [])];
  }

  /** Cookies of a storage record (the snapshot's or its baseline's) by name, in capture order. */
  cookies(storage: StorageRecord): ReadonlyMap<string, readonly CookieRecord[]> {
    return cookiesByName(storage);
  }

  /**
   * `snapshotDigest(snapshot)`, computed once: the digest taken at capture time when this
   * is the captured object, unchanged (`capturedDigest`, ADR 0016), else computed here.
   */
  get digest(): string {
    return (this.digestValue ??= capturedDigest(this.snapshot) ?? snapshotDigest(this.snapshot));
  }

  /**
   * The digest of each top-level section (its canonical JSON), computed once: what a later
   * delta format and scoped capture address sections by. The baseline's digest leaves out its
   * capture time, as the snapshot digest does.
   */
  get sectionDigests(): Readonly<Partial<Record<Section, string>>> {
    if (!this.sectionDigestsValue) {
      const out: Partial<Record<Section, string>> = {};
      for (const [k, v] of Object.entries(this.snapshot) as [keyof EvidenceSnapshot, unknown][]) {
        if (k === 'capturedAt' || v === undefined) continue;
        if (k === 'baseline') {
          const { capturedAt: _ignored, ...baseline } = v as NonNullable<EvidenceSnapshot['baseline']>;
          out.baseline = sha256(canonicalJson(baseline));
        } else out[k] = sha256(canonicalJson(v));
      }
      this.sectionDigestsValue = Object.freeze(out);
    }
    return this.sectionDigestsValue;
  }
}

const cookieIndexes = new WeakMap<StorageRecord, Map<string, CookieRecord[]>>();

/** The cookies of a storage record by name, in capture order; built once per record object. */
export function cookiesByName(storage: StorageRecord): ReadonlyMap<string, readonly CookieRecord[]> {
  let m = cookieIndexes.get(storage);
  if (!m) {
    m = new Map<string, CookieRecord[]>();
    for (const c of storage.cookies) {
      let l = m.get(c.name);
      if (!l) m.set(c.name, (l = []));
      l.push(c);
    }
    cookieIndexes.set(storage, m);
  }
  return m;
}

/** The keys of `a` and `b` whose values differ by identity, each added as `prefix + key`. */
function diffKeys(a: object, b: object, prefix: string, out: Set<string>): void {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k in y) if (x[k] !== y[k]) out.add(prefix + k);
  for (const k in x) if (x[k] !== y[k]) out.add(prefix + k);
}

const isObject = (x: unknown): x is object => !!x && typeof x === 'object';

/**
 * Where `next` differs from `base`, by identity: what an overlay replaced (ADR 0016), as the
 * read keys of `readKeys` (top-level sections, or single probes and parts of the baseline
 * where only those were replaced). Parts shared by identity are the same evidence, since a
 * snapshot is not edited once it has been verified. Null when either is not an object.
 */
export function changedKeys(base: EvidenceSnapshot, next: EvidenceSnapshot): Set<string> | null {
  if (!isObject(base) || !isObject(next)) return null;
  const top = new Set<string>();
  diffKeys(base, next, '', top);
  const out = new Set<string>();
  for (const k of top) {
    const a = (base as unknown as Record<string, unknown>)[k];
    const b = (next as unknown as Record<string, unknown>)[k];
    if (k === 'probes' && isObject(a) && isObject(b)) diffKeys(a, b, 'probes:', out);
    else if (k === 'baseline' && isObject(a) && isObject(b)) {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      const parts = new Set<string>();
      diffKeys(x, y, '', parts);
      for (const part of parts) {
        if (part === 'probes' && isObject(x.probes) && isObject(y.probes))
          diffKeys(x.probes, y.probes, 'baseline.probes:', out);
        else out.add(`baseline.${part}`);
      }
    } else out.add(k);
  }
  return out;
}

const stores = new WeakMap<object, EvidenceStore>();

/**
 * The store of `snapshot`, built on first use and cached for the snapshot object: repeated
 * `verify` calls (and every check set) on the same object share its indexes and digest.
 * A snapshot must not be edited once it has been verified; edit a copy instead.
 */
export function buildStore(snapshot: EvidenceSnapshot): EvidenceStore {
  if (!snapshot || typeof snapshot !== 'object') return new EvidenceStore(snapshot);
  let s = stores.get(snapshot);
  if (!s) stores.set(snapshot, (s = new EvidenceStore(snapshot)));
  return s;
}
