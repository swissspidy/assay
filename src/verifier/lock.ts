/**
 * Human confirmation (pipeline step 5): a reviewer reads each check in plain
 * language and locks the set. A locked set carries who locked it, when, and the
 * digest of exactly what was confirmed; any later edit breaks the lock.
 */
import type { Assertion, CheckSet, Locator, Target, TextMatch, ValueSource } from '../types.ts';
import { checkSetDigest } from '../snapshot/digest.ts';
import { describeTextMatch } from '../text.ts';
import { describeLocator } from '../runtime/axindex.ts';
import { describeNumberCompare } from '../runtime/compare.ts';
import { describeRequestMatch, describeUrlMatch } from '../runtime/network.ts';

export interface Lock {
  by: string;
  at: string;
  digest: string;
}

export type LockedCheckSet = CheckSet & { locked: Lock };

function unlocked(cs: CheckSet): CheckSet {
  const { locked: _l, ...rest } = cs as CheckSet & { locked?: Lock };
  return rest;
}

export function lockCheckSet(cs: CheckSet, by: string, at = new Date().toISOString()): LockedCheckSet {
  const base = unlocked(cs);
  return { ...base, locked: { by, at, digest: checkSetDigest(base) } };
}

/** True when the set carries a lock whose digest still matches its content. */
export function isLocked(cs: CheckSet): cs is LockedCheckSet {
  const lock = (cs as CheckSet & { locked?: Lock }).locked;
  return !!lock && lock.digest === checkSetDigest(unlocked(cs));
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
      return `${s.area === 'cookie' ? 'cookie' : `${s.area}Storage`} ${JSON.stringify(s.key)}`;
    case 'probe':
      return `backend probe ${s.probe}${s.pointer ? ` at ${s.pointer}` : ''}`;
  }
}

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
      return `${source(a.source)}${a.normalize?.length ? `, normalized by ${a.normalize.map((n) => (typeof n === 'string' ? n : n.op)).join(' → ')}` : ''}, ${JSON.stringify(a.expect)}`;
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
      lines.push(`- **${c.id}** ${c.description}`, `  - tests: ${describeAssertion(c.assert)}`);
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
