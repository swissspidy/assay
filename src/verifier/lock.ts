/**
 * Human confirmation (pipeline step 5): a reviewer reads each check in plain
 * language and locks the set. A locked set carries who locked it, when, and the
 * digest of exactly what was confirmed; any later edit breaks the lock.
 */
import type { Assertion, CheckSet, Locator, Normalizer, Target, TextMatch, ValueSource } from '../types.ts';
import { checkSetDigest } from '../snapshot/digest.ts';
import { describeTextMatch } from '../text.ts';
import { describeLocator } from '../runtime/axindex.ts';
import { describeNumberCompare } from '../runtime/compare.ts';
import { describeRequestMatch, describeUrlMatch } from '../runtime/network.ts';

export interface Lock {
  by: string;
  at: string;
  /** Digest of the set's content together with `by` and `at`. */
  digest: string;
}

export type LockedCheckSet = CheckSet & { locked: Lock };

function unlocked(cs: CheckSet): CheckSet {
  const { locked: _l, ...rest } = cs as CheckSet & { locked?: Lock };
  return rest;
}

/** The digest covers the content and who locked it when, so neither can be edited silently. */
function lockDigest(base: CheckSet, by: string, at: string): string {
  return checkSetDigest({ ...base, locked: { by, at } });
}

/**
 * Lock a reviewed check set. The digest is unkeyed: it makes accidental or
 * careless edits evident, but anyone can re-lock an edited file. Where locks must
 * prove who confirmed what, keep a registry of digests outside the file or sign them.
 */
export function lockCheckSet(cs: CheckSet, by: string, at = new Date().toISOString()): LockedCheckSet {
  const base = unlocked(cs);
  return { ...base, locked: { by, at, digest: lockDigest(base, by, at) } };
}

/** True when the set carries a lock whose digest still matches its content, author and time. */
export function isLocked(cs: CheckSet): cs is LockedCheckSet {
  const lock = (cs as CheckSet & { locked?: Lock }).locked;
  return !!lock && lock.digest === lockDigest(unlocked(cs), lock.by, lock.at);
}

/** For records: the valid lock (if any) and whether a lock is present but broken. */
export function lockState(cs: CheckSet): { locked: { by: string; at: string } | null; broken: boolean } {
  const lock = (cs as CheckSet & { locked?: Lock }).locked;
  if (!lock) return { locked: null, broken: false };
  return isLocked(cs) ? { locked: { by: lock.by, at: lock.at }, broken: false } : { locked: null, broken: true };
}

const target = (t: Target) =>
  'anchors' in t
    ? t.anchors.map(describeLocator).join(' (or ') + (t.anchors.length > 1 ? ')' : '')
    : describeLocator(t);
const loc = (l: Locator) => describeLocator(l);
const tm = (m: TextMatch) => describeTextMatch(m);

function source(s: ValueSource): string {
  switch (s.from) {
    case 'node':
      return `the ${s.field} of ${target(s.target)}`;
    case 'text':
      return `page text matching /${s.pattern}/${s.scope ? ` inside ${target(s.scope)}` : ''} (free text, spoofable)`;
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

/** A mechanical plain-language rendering of what an assertion actually tests. */
export function describeAssertion(a: Assertion): string {
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
      return `${a.scope ? target(a.scope) : 'the page'} contains ${describeNumberCompare(a.count ?? { gte: 1 })} ${loc(a.match)}${a.witness ? ` (witness: ${loc(a.witness)} must exist)` : ''}`;
    case 'value':
      return 'sameAs' in a.expect
        ? `${source(a.source)}${normalized(a.normalize)}, equals ${source(a.expect.sameAs.source)}${normalized(a.expect.sameAs.normalize)}`
        : `${source(a.source)}${normalized(a.normalize)}, ${JSON.stringify(a.expect)}`;
    case 'url':
      return `the page URL matches ${describeUrlMatch(a.match)}`;
    case 'request':
      return `${describeNumberCompare(a.count ?? { gte: 1 })} request(s) match ${describeRequestMatch(a.match)}`;
    case 'allOf':
      return `all of: ${a.of.map(describeAssertion).join('; ')}`;
    case 'anyOf':
      return `any of: ${a.of.map(describeAssertion).join('; ')}`;
  }
}

/** Markdown review sheet: each requirement with its quote, each check's description and what it mechanically tests. */
export function reviewSheet(cs: CheckSet): string {
  const lines = [`# Review: ${cs.id} v${cs.version}`, '', `**Instruction:** ${cs.task.instruction}`];
  if (cs.task.outcomes)
    lines.push('', '**Expected outcomes:**', '', ...cs.task.outcomes.split('\n').map((l) => `> ${l}`));
  for (const r of cs.requirements) {
    lines.push('', `## ${r.id} (${r.kind}): "${r.source.quote}"`);
    for (const c of cs.checks.filter((x) => x.requirement === r.id)) {
      // One line per description: a line break could forge a heading or another check's entry.
      const description = c.description.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
      lines.push(`- **${c.id}** ${description}`, `  - tests: ${describeAssertion(c.assert)}`);
      if (c.onFail) lines.push(`  - on fail: ${c.onFail === 'escalate' ? 'escalate to the verifier' : 'keep the failure'}`);
    }
  }
  const lock = (cs as CheckSet & { locked?: Lock }).locked;
  lines.push(
    '',
    lock
      ? `Locked by ${lock.by} at ${lock.at} (${isLocked(cs) ? 'valid' : 'BROKEN: content changed after locking'}).`
      : 'Not locked.',
  );
  return lines.join('\n');
}
