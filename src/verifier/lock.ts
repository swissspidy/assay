/**
 * Human confirmation (pipeline step 5, ADR 0013): a compiled check set is a proposal
 * until a reviewer reads its review sheet and approves it, which locks it, or rejects
 * it with a note. A lock records who approved what and when: a digest over the set and
 * every lock field, per-item digests that name what changed after approval, and
 * optionally an Ed25519 signature that ties the approval to a key.
 */
import type {
  Assertion,
  CheckSet,
  Locator,
  Lock,
  Normalizer,
  Rejection,
  Target,
  TextMatch,
  ValueSource,
} from '../types.ts';
import { canonicalJson, checkSetDigest, sha256 } from '../snapshot/digest.ts';
import { assertValidCheckSet } from '../dsl/validate.ts';
import { describeTextMatch } from '../text.ts';
import { describeLocator } from '../runtime/axindex.ts';
import { describeNumberCompare } from '../runtime/compare.ts';
import { describePageMatch, describeRequestMatch, describeUrlMatch } from '../runtime/network.ts';
import {
  keyId,
  signDigest,
  trustedKeySet,
  verifyDigest,
  type KeyInput,
  type TrustedKey,
  type TrustedKeySet,
} from './sign.ts';

export type LockedCheckSet = CheckSet & { locked: Lock };

type Reviewed = CheckSet & { locked?: Lock; rejected?: Rejection };

/** The set without its review state (lock, rejection). */
export function unlocked(cs: CheckSet): CheckSet {
  const { locked: _l, rejected: _r, ...rest } = cs as Reviewed;
  return rest;
}

/**
 * Digest of the normalized check set: canonical JSON (keys sorted, no whitespace,
 * undefined dropped) of everything but the lock and a rejection. Array order counts.
 */
export function contentDigest(cs: CheckSet): string {
  return checkSetDigest(unlocked(cs));
}

/** Digest of a stress report (as `stressTest` returns it or `assay stress --json` prints it). */
export function stressDigest(report: unknown): string {
  return sha256(canonicalJson(report));
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Why `report` is not a stress report (as `stressTest` returns it or `assay stress --json`
 * prints it), or undefined when it is one.
 */
export function stressReportProblem(report: unknown): string | undefined {
  if (!isObj(report)) return 'not an object';
  const cs = report.checkSet;
  if (!isObj(cs) || typeof cs.id !== 'string' || typeof cs.version !== 'string') return 'no checkSet { id, version }';
  for (const k of [
    'references',
    'variants',
    'mutants',
    'overConstrained',
    'fragile',
    'weak',
    'missed',
    'advisories',
    'untested',
  ])
    if (!Array.isArray(report[k])) return `no ${k} list`;
  if (!isObj(report.rates) || !Object.values(report.rates).every((v) => typeof v === 'number')) return 'no rates';
  for (const k of ['overConstrained', 'fragile', 'weak'])
    if (!(report[k] as unknown[]).every((f) => isObj(f) && typeof f.check === 'string'))
      return `a malformed ${k} entry`;
  return undefined;
}

/** Digests of each part of a set, keyed "id", "version", "task", "compiled", "requirement:<id>", "check:<id>". */
const h = (v: unknown) => sha256(canonicalJson(v));

export function itemDigests(cs: CheckSet): Record<string, string> {
  const items: Record<string, string> = { id: h(cs.id), version: h(cs.version), task: h(cs.task) };
  if (cs.compiled) items.compiled = h(cs.compiled);
  for (const r of cs.requirements) items[`requirement:${r.id}`] = h(r);
  for (const c of cs.checks) items[`check:${c.id}`] = h(c);
  return items;
}

/** The digest covers the content and every lock field but the signature, so none can be edited silently. */
function lockDigest(base: CheckSet, lock: Omit<Lock, 'digest' | 'signature'>): string {
  return checkSetDigest({ ...base, locked: lock });
}

export interface ApproveOptions {
  /** The reviewer: a name or e-mail address. */
  by: string;
  /** When (default now). */
  at?: string;
  note?: string;
  /** Ed25519 private key (PEM or key object): sign the lock. Without it the lock is unsigned. */
  key?: KeyInput;
  /** The stress report the reviewer saw; its digest goes into the lock. It must be for this set's id and version. */
  stress?: unknown;
}

/**
 * Approve a reviewed check set: validate it (throws `CheckSetError`) and lock it, signed
 * when `key` is given. Replaces an earlier lock or rejection.
 */
export function approveCheckSet(cs: CheckSet, opts: ApproveOptions): LockedCheckSet {
  const valid = assertValidCheckSet(cs);
  const base = unlocked(valid);
  if (!opts.by.trim()) throw new Error('approving needs the reviewer');
  const previous = (cs as Reviewed).locked;
  if (opts.at !== undefined && !opts.at.trim()) throw new Error('approving needs a time (`at` is empty)');
  if (opts.stress !== undefined) {
    const problem = stressReportProblem(opts.stress);
    if (problem) throw new Error(`not a stress report: ${problem}`);
    const of = (opts.stress as { checkSet: { id: string; version: string } }).checkSet;
    if (of.id !== base.id || of.version !== base.version)
      throw new Error(
        `the stress report is for ${String(of?.id)} v${String(of?.version)}, not ${base.id} v${base.version}`,
      );
  }
  const fields: Omit<Lock, 'digest' | 'signature'> = {
    by: opts.by,
    at: opts.at ?? new Date().toISOString(),
    ...(opts.note ? { note: opts.note } : {}),
    content: checkSetDigest(base),
    items: itemDigests(base),
    ...(opts.stress !== undefined ? { stress: stressDigest(opts.stress) } : {}),
    ...(previous?.digest ? { supersedes: previous.digest } : {}),
  };
  const digest = lockDigest(base, fields);
  const lock: Lock = { ...fields, digest };
  if (opts.key !== undefined)
    lock.signature = { alg: 'ed25519', keyId: keyId(opts.key), value: signDigest(digest, opts.key) };
  return { ...base, locked: lock };
}

/**
 * Lock a reviewed check set, unsigned. Any later edit breaks the lock, but anyone can
 * re-lock an edited file: to prove who approved it, sign with `approveCheckSet`.
 */
export function lockCheckSet(cs: CheckSet, by: string, at = new Date().toISOString()): LockedCheckSet {
  return approveCheckSet(cs, { by, at });
}

/** Reject a proposal with a note saying why. Removes a lock. */
export function rejectCheckSet(cs: CheckSet, opts: { by: string; note: string; at?: string }): CheckSet {
  if (!opts.by.trim()) throw new Error('rejecting needs the reviewer');
  if (!opts.note.trim()) throw new Error('rejecting needs a note saying why');
  if (opts.at !== undefined && !opts.at.trim()) throw new Error('rejecting needs a time (`at` is empty)');
  const base = unlocked(cs);
  const rejected: Rejection = {
    by: opts.by,
    at: opts.at ?? new Date().toISOString(),
    note: opts.note,
    content: checkSetDigest(base),
  };
  return { ...base, rejected } as CheckSet;
}

/** Remove the lock (and a rejection): the set is a proposal again. */
export function unlockCheckSet(cs: CheckSet): CheckSet {
  return unlocked(cs);
}

export interface LockChange {
  /** What changed: "task", "id", "version", "compiled", or a requirement or check. */
  part: 'task' | 'id' | 'version' | 'compiled' | 'requirement' | 'check';
  /** The requirement or check id. */
  id?: string;
  change: 'added' | 'removed' | 'changed';
}

export const describeChange = (c: LockChange): string =>
  `${c.part === 'compiled' ? 'compiler provenance' : c.part}${c.id !== undefined ? ` ${c.id}` : ''} ${c.change}`;

const PARTS: LockChange['part'][] = ['id', 'version', 'task', 'compiled', 'requirement', 'check'];

function parseItem(key: string): Omit<LockChange, 'change'> {
  const i = key.indexOf(':');
  return i === -1
    ? { part: key as LockChange['part'] }
    : { part: key.slice(0, i) as LockChange['part'], id: key.slice(i + 1) };
}

const rank = (k: string) => PARTS.indexOf(parseItem(k).part);

/** What differs between the item digests of a lock and those of the set now. */
export function changedItems(before: Record<string, string>, after: Record<string, string>): LockChange[] {
  const out: LockChange[] = [];
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])].toSorted((a, b) => rank(a) - rank(b));
  for (const k of keys) {
    const change = !(k in before)
      ? 'added'
      : !(k in after)
        ? 'removed'
        : before[k] !== after[k]
          ? 'changed'
          : undefined;
    if (change) out.push({ ...parseItem(k), change });
  }
  return out;
}

export type SignatureStatus =
  /** Not signed. */
  | 'none'
  /** Signed, but no trusted keys were given to check it with. */
  | 'unchecked'
  /** Signed by one of the trusted keys, and the signature verifies. */
  | 'trusted'
  /** Signed by a key that is not trusted. */
  | 'untrusted'
  /** Signed under a trusted key's id, but the signature does not verify: the lock is broken. */
  | 'invalid';

export interface LockStatus {
  /** "none": no lock; "valid": the lock matches the set (and a checked signature verifies); "broken": it does not. */
  state: 'none' | 'valid' | 'broken';
  lock?: Lock;
  signature: SignatureStatus;
  /** The name of the trusted key that signed the lock. */
  signer?: string;
  /** What changed since the lock was made, when the lock has item digests. */
  changes: LockChange[];
  /** Why the lock is broken, in plain language. */
  problems: string[];
}

export interface LockCheckOptions {
  /** Public keys whose signatures are trusted. Without them a signature is not checked. */
  trustedKeys?: readonly TrustedKey[] | TrustedKeySet;
}

const keySet = (k: LockCheckOptions['trustedKeys']): TrustedKeySet | undefined =>
  k === undefined
    ? undefined
    : 'keys' in k && k.keys instanceof Map
      ? (k as TrustedKeySet)
      : trustedKeySet(k as TrustedKey[]);

/** Check a set's lock: its digest against the content, and its signature against trusted keys. */
export function verifyLock(cs: CheckSet, opts: LockCheckOptions = {}): LockStatus {
  const lock = (cs as Reviewed).locked;
  if (!lock) return { state: 'none', signature: 'none', changes: [], problems: [] };
  const base = unlocked(cs);
  const { digest, signature: sig, ...fields } = lock;
  const problems: string[] = [];
  if ((cs as Reviewed).rejected) problems.push('the set is both locked and rejected');
  let changes: LockChange[] = [];
  if (lockDigest(base, fields) !== digest) {
    // The set still has the approved content: the lock itself was edited.
    if (lock.content === checkSetDigest(base))
      problems.push("the lock's own fields (reviewer, time, note or digests) were edited");
    else {
      if (lock.items) changes = changedItems(lock.items, itemDigests(base));
      if (changes.length) problems.push(`changed after approval: ${changes.map(describeChange).join(', ')}`);
      else if (lock.content) problems.push('changed after approval: requirements or checks were reordered');
      else problems.push('content, reviewer or time changed after locking (an older lock cannot say which)');
    }
  }
  let signature: SignatureStatus = 'none';
  let signer: string | undefined;
  if (sig) {
    const trusted = keySet(opts.trustedKeys);
    const k = trusted?.keys.get(sig.keyId);
    if (!trusted) signature = 'unchecked';
    else if (!k) signature = 'untrusted';
    else if (sig.alg === 'ed25519' && verifyDigest(digest, sig.value, k.key)) {
      signature = 'trusted';
      signer = k.name;
    } else {
      signature = 'invalid';
      problems.push(`the signature does not verify with trusted key ${k.name}`);
    }
  }
  return {
    state: problems.length ? 'broken' : 'valid',
    lock,
    signature,
    ...(signer ? { signer } : {}),
    changes,
    problems,
  };
}

/** True when the set carries a lock whose digest still matches its content and lock fields. The signature is not checked. */
export function isLocked(cs: CheckSet): cs is LockedCheckSet {
  return verifyLock(cs).state === 'valid';
}

/** What `verify` and friends require of a set's lock: any valid lock, or one signed by a trusted key. */
export type LockRequirement = boolean | { trustedKeys: readonly TrustedKey[] | TrustedKeySet };

/** Thrown when a check set does not carry the lock `requireLocked` asks for. */
export class LockError extends Error {
  readonly status: LockStatus;
  constructor(message: string, status: LockStatus) {
    super(message);
    this.status = status;
    this.name = 'LockError';
  }
}

/** Throw a `LockError` unless the set meets `requireLocked`. */
export function assertLocked(cs: CheckSet, requireLocked: LockRequirement | undefined): LockStatus | undefined {
  if (!requireLocked) return undefined;
  const signed = typeof requireLocked === 'object';
  const status = verifyLock(cs, signed ? { trustedKeys: keySet(requireLocked.trustedKeys) } : {});
  const name = `Check set ${cs.id} v${cs.version}`;
  if (status.state === 'none') {
    const rejected = (cs as Reviewed).rejected;
    throw new LockError(
      rejected && rejected.content === contentDigest(cs)
        ? `${name} is not locked: ${rejected.by} rejected it (${rejected.note.replace(/\s+/g, ' ').trim()}).`
        : `${name} is not locked: it is a proposal nobody has approved.`,
      status,
    );
  }
  if (status.state === 'broken')
    throw new LockError(`${name} is not locked: its lock is broken (${status.problems.join('; ')}).`, status);
  if (signed && status.signature !== 'trusted')
    throw new LockError(
      status.signature === 'none'
        ? `${name} is locked by ${status.lock!.by} but not signed; a signature from a trusted key is required.`
        : `${name} is signed with key ${status.lock!.signature!.keyId}, which is not a trusted key.`,
      status,
    );
  return status;
}

/** For records: the valid lock (if any), whether a lock is present but broken, and why. */
export function lockState(
  cs: CheckSet,
  opts: LockCheckOptions = {},
): {
  locked: { by: string; at: string; signature?: { keyId: string; status: SignatureStatus; signer?: string } } | null;
  broken: boolean;
  problems: string[];
} {
  const s = verifyLock(cs, opts);
  if (s.state !== 'valid') return { locked: null, broken: s.state === 'broken', problems: s.problems };
  const l = s.lock!;
  return {
    locked: {
      by: l.by,
      at: l.at,
      ...(l.signature
        ? { signature: { keyId: l.signature.keyId, status: s.signature, ...(s.signer ? { signer: s.signer } : {}) } }
        : {}),
    },
    broken: false,
    problems: [],
  };
}

export type ReviewState = 'proposal' | 'approved' | 'changed' | 'rejected';

/**
 * Where a set is in its review: a "proposal" (never approved, or revised after a
 * rejection), "approved" (a valid lock), "changed" (a lock that no longer matches,
 * so the set needs a fresh approval) or "rejected" (the rejected content, unchanged).
 */
export function reviewState(
  cs: CheckSet,
  opts: LockCheckOptions = {},
): { state: ReviewState; lock: LockStatus; rejected?: Rejection } {
  const lock = verifyLock(cs, opts);
  const rejected = (cs as Reviewed).rejected;
  if (lock.state === 'valid') return { state: 'approved', lock };
  if (lock.state === 'broken') return { state: 'changed', lock };
  if (rejected) return { state: rejected.content === contentDigest(cs) ? 'rejected' : 'proposal', lock, rejected };
  return { state: 'proposal', lock };
}

const target = (t: Target) =>
  'anchors' in t
    ? t.anchors.map(describeLocator).join(' (or ') + (t.anchors.length > 1 ? ')' : '')
    : describeLocator(t);
const loc = (l: Locator) => describeLocator(l);
const tm = (m: TextMatch) => describeTextMatch(m);

/** `inRecord`: inside an `each`, where an unscoped text source reads the record's text. */
function source(s: ValueSource, inRecord = false): string {
  switch (s.from) {
    case 'node':
      return `the ${s.field} of ${target(s.target)}`;
    case 'text':
      return `${inRecord && !s.scope ? 'the record' : 'page'} text matching /${s.pattern}/${s.scope ? ` inside ${target(s.scope)}` : ''} (free text, spoofable)`;
    case 'url':
      return `the page URL's ${typeof s.part === 'object' ? `query parameter ${s.part.param}` : s.part}`;
    case 'request':
    case 'response':
      return `the ${s.from} body${s.pointer ? ` at ${s.pointer}` : ''} of ${s.pick ?? 'the only'} request matching ${describeRequestMatch(s.match)}`;
    case 'storage':
      return `${s.area === 'cookie' ? 'cookie' : `${s.area}Storage`} ${JSON.stringify(s.key)}${s.at === 'before' ? ' before the task' : ''}`;
    case 'probe':
      return `backend probe ${s.probe}${s.pointer ? ` at ${s.pointer}` : ''}${s.at === 'before' ? ' before the task' : ''}`;
  }
}

const normalized = (steps: Normalizer[] | undefined) =>
  steps?.length
    ? `, normalized by ${steps.map((n) => (typeof n === 'string' ? n : JSON.stringify(n))).join(' → ')}`
    : '';

/**
 * A mechanical plain-language rendering of what an assertion actually tests. `inRecord`:
 * inside an `each`, where an unscoped contains or text source reads the record.
 */
export function describeAssertion(a: Assertion, inRecord = false): string {
  const where = (scope: Target | undefined) => (scope ? target(scope) : inRecord ? 'the record' : 'the page');
  switch (a.kind) {
    case 'state': {
      const parts = Object.entries(a.expect).map(([k, v]) =>
        typeof v === 'object' || (typeof v === 'string' && !['mixed'].includes(v))
          ? `${k} ${tm(v as TextMatch)}`
          : `${k} = ${String(v)}`,
      );
      return `${target(a.target)} has ${parts.join(', ')}`;
    }
    case 'contains':
      return `${where(a.scope)} contains ${describeNumberCompare(a.count ?? { gte: 1 })} ${loc(a.match)}${a.witness ? ` (witness: ${loc(a.witness)} must exist)` : ''}`;
    case 'value':
      return 'sameAs' in a.expect
        ? `${source(a.source, inRecord)}${normalized(a.normalize)}, equals ${source(a.expect.sameAs.source, inRecord)}${normalized(a.expect.sameAs.normalize)}`
        : `${source(a.source, inRecord)}${normalized(a.normalize)}, ${JSON.stringify(a.expect)}`;
    case 'url':
      return `the page URL matches ${describeUrlMatch(a.match)}`;
    case 'request':
      return `${describeNumberCompare(a.count ?? { gte: 1 })} request(s) match ${describeRequestMatch(a.match)}`;
    case 'each': {
      const record = a.match.role === 'term' ? `${loc(a.match)} (with its definitions)` : loc(a.match);
      return `in ${where(a.scope)}, ${describeNumberCompare(a.count ?? { gte: 1 })} ${record}${a.witness ? ` (witness: ${loc(a.witness)} must exist once)` : ''}, and inside each: ${describeAssertion(a.assert, true)}`;
    }
    case 'page':
      return `on the one open page (tab or popup) with ${describePageMatch(a.match)}: ${describeAssertion(a.assert)}`;
    case 'allOf':
      return `all of: ${a.of.map((b) => describeAssertion(b, inRecord)).join('; ')}`;
    case 'anyOf':
      return `any of: ${a.of.map((b) => describeAssertion(b, inRecord)).join('; ')}`;
  }
}
