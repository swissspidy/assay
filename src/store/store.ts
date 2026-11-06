/**
 * The evidence store (ADR 0015): one immutable, indexed view of a snapshot, built once per
 * snapshot object and shared by every check, every `verify` call and every check set that
 * reads it.
 */
import type { AXNode, CookieRecord, EvidenceSnapshot, PageView, StorageRecord } from '../types.ts';
import { AXIndex } from '../runtime/axindex.ts';
import { canonicalJson, sha256, snapshotDigest } from '../snapshot/digest.ts';
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

  /** `snapshotDigest(snapshot)`, computed once. */
  get digest(): string {
    return (this.digestValue ??= snapshotDigest(this.snapshot));
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
