/**
 * Semantic diff of two versions of a check set (ADR 0013): which requirements and
 * checks were added, removed or changed, in the review sheet's plain language, and
 * which requirements a reviewer must therefore look at again.
 */
import type { Assertion, Channel, Check, CheckSet, Requirement, ValueSource } from '../types.ts';
import { CHANNEL_TRUST } from '../types.ts';
import { canonicalJson } from '../snapshot/digest.ts';
import { contentDigest, describeAssertion, unlocked } from './lock.ts';
import { cat, oneLine, render, type Block, type DocFormat, type Inline, type ListItem } from './doc.ts';

const CHANNEL_NAMES: Record<Channel, string> = {
  a11y: 'accessibility tree',
  text: 'page text',
  url: 'URL',
  network: 'network log',
  storage: 'storage',
  probe: 'backend probe',
};

const TRUST_NAMES = { structured: 'structured', semantic: 'semantic', freetext: 'free text, spoofable' } as const;

function sourceChannel(s: ValueSource): Channel {
  switch (s.from) {
    case 'node':
      return 'a11y';
    case 'text':
      return 'text';
    case 'url':
      return 'url';
    case 'request':
    case 'response':
      return 'network';
    case 'storage':
      return 'storage';
    case 'probe':
      return 'probe';
  }
}

function channels(a: Assertion, out: Set<Channel>): void {
  switch (a.kind) {
    case 'state':
    case 'contains':
    case 'each':
      out.add('a11y');
      break;
    case 'value':
      out.add(sourceChannel(a.source));
      if ('sameAs' in a.expect) out.add(sourceChannel(a.expect.sameAs.source));
      break;
    case 'url':
      out.add('url');
      break;
    case 'request':
      out.add('network');
      break;
    case 'page':
      // The page is selected by its URL (and/or title); then the inner assertion reads it.
      if (a.match.url) out.add('url');
      break;
  }
  // Composite assertions (allOf, anyOf, each, and any that wrap another) read what their parts read.
  const parts = a as { assert?: Assertion; of?: Assertion[] };
  if (parts.assert) channels(parts.assert, out);
  for (const b of parts.of ?? []) channels(b, out);
}

/** The evidence an assertion reads, strongest first, e.g. ["network log (structured)", "page text (free text, spoofable)"]. */
export function evidenceRead(a: Assertion): string[] {
  const set = new Set<Channel>();
  channels(a, set);
  const rank = { structured: 0, semantic: 1, freetext: 2 } as const;
  return [...set]
    .toSorted((x, y) => rank[CHANNEL_TRUST[x]] - rank[CHANNEL_TRUST[y]])
    .map((c) => `${CHANNEL_NAMES[c]} (${TRUST_NAMES[CHANNEL_TRUST[c]]})`);
}

/** A check's settings other than its assertion, in plain language. */
export function checkSettings(c: Check): string[] {
  const out: string[] = [];
  if (c.onFail) out.push(`on fail: ${c.onFail === 'escalate' ? 'escalate to the verifier' : 'keep the failure'}`);
  if (c.onMissing === 'abstain') out.push('on missing route evidence: abstain (the run may have done it another way)');
  else if (c.onMissing === 'fail') out.push('on missing route evidence: fail');
  return out;
}

/** A check as a reviewer reads it. */
export interface CheckView {
  id: string;
  requirement: string;
  description: string;
  tests: string;
  reads: string[];
  settings: string[];
}

export interface RequirementView {
  id: string;
  kind: 'hard' | 'soft';
  text: string;
  quote: string;
  field: 'instruction' | 'outcomes';
}

export const checkView = (c: Check): CheckView => ({
  id: c.id,
  requirement: c.requirement,
  description: oneLine(c.description),
  tests: describeAssertion(c.assert),
  reads: evidenceRead(c.assert),
  settings: checkSettings(c),
});

const requirementView = (r: Requirement): RequirementView => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  quote: r.source.quote,
  field: r.source.field,
});

export interface Changed<T> {
  id: string;
  before: T;
  after: T;
  /** What changed, in plain words: "description", "what it tests", "requirement", "on fail", "kind", ... */
  fields: string[];
}

export interface CheckSetDiff {
  from: { id: string; version: string; content: string };
  to: { id: string; version: string; content: string };
  /** The two sets have the same content (their review state aside). */
  identical: boolean;
  /** Changes to the set itself: id, version, instruction, expected outcomes, compiler provenance. */
  set: { field: string; before?: string; after?: string }[];
  requirements: {
    added: RequirementView[];
    removed: RequirementView[];
    changed: Changed<RequirementView>[];
    /** Same content under a new id. */
    renamed: { from: string; to: string }[];
    unchanged: string[];
  };
  checks: {
    added: CheckView[];
    removed: CheckView[];
    changed: Changed<CheckView>[];
    /** Same content under a new id. */
    renamed: { from: string; to: string }[];
    unchanged: string[];
  };
  /** Requirements or checks kept in both versions now come in another order. */
  reordered: { requirements: boolean; checks: boolean };
  /**
   * Requirements of the new set a reviewer must look at again: added or changed, or with
   * a check added, removed, changed, renamed or moved; every requirement when the task changed.
   */
  toReview: string[];
}

const CHECK_FIELDS: Record<string, string> = {
  description: 'description',
  assert: 'what it tests',
  requirement: 'requirement',
  onFail: 'on fail',
  onMissing: 'on missing route evidence',
};

const REQUIREMENT_FIELDS: Record<string, string> = { kind: 'kind', text: 'text', source: 'source' };

const get = (o: object, k: string) => canonicalJson((o as Record<string, unknown>)[k] ?? null);

function fieldsChanged(a: object, b: object, names: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'id');
  return keys.filter((k) => get(a, k) !== get(b, k)).map((k) => names[k] ?? k);
}

const prov = (cs: CheckSet) =>
  cs.compiled
    ? `${cs.compiled.compiler} with ${cs.compiled.model} (served by ${cs.compiled.modelsUsed.join(', ') || 'none'}) at ${cs.compiled.at}`
    : undefined;
const sameContent = (c: { id: string }) => canonicalJson({ ...c, id: '' });

/** Whether the ids both lists keep appear in another order. */
function reorderedIds(a: { id: string }[], b: { id: string }[]): boolean {
  const inB = new Set(b.map((x) => x.id));
  const inA = new Set(a.map((x) => x.id));
  const x = a.map((r) => r.id).filter((id) => inB.has(id));
  const y = b.map((r) => r.id).filter((id) => inA.has(id));
  return x.some((id, i) => id !== y[i]);
}

/** Compare two versions of a check set (requirements and checks are matched by id). */
export function diffCheckSets(before: CheckSet, after: CheckSet): CheckSetDiff {
  const a = unlocked(before);
  const b = unlocked(after);
  const set: CheckSetDiff['set'] = [];
  const field = (name: string, x: string | undefined, y: string | undefined) => {
    if (x !== y)
      set.push({ field: name, ...(x !== undefined ? { before: x } : {}), ...(y !== undefined ? { after: y } : {}) });
  };
  field('id', a.id, b.id);
  field('version', a.version, b.version);
  field('instruction', a.task.instruction, b.task.instruction);
  field('expected outcomes', a.task.outcomes, b.task.outcomes);
  if (canonicalJson(a.compiled ?? null) !== canonicalJson(b.compiled ?? null))
    field('compiled', prov(a) ?? 'handwritten', prov(b) ?? 'handwritten');

  const reqsA = new Map(a.requirements.map((r) => [r.id, r]));
  const reqsB = new Map(b.requirements.map((r) => [r.id, r]));
  const requirements: CheckSetDiff['requirements'] = {
    added: [],
    removed: [],
    changed: [],
    renamed: [],
    unchanged: [],
  };
  const removedReqs = a.requirements.filter((r) => !reqsB.has(r.id));
  for (const r of b.requirements) {
    const old = reqsA.get(r.id);
    if (!old) {
      // Same content under a new id: renamed, not rewritten.
      const i = removedReqs.findIndex((x) => sameContent(x) === sameContent(r));
      if (i === -1) requirements.added.push(requirementView(r));
      else requirements.renamed.push({ from: removedReqs.splice(i, 1)[0]!.id, to: r.id });
    } else {
      const fields = fieldsChanged(old, r, REQUIREMENT_FIELDS);
      if (fields.length)
        requirements.changed.push({ id: r.id, before: requirementView(old), after: requirementView(r), fields });
      else requirements.unchanged.push(r.id);
    }
  }
  requirements.removed.push(...removedReqs.map(requirementView));

  const checksA = new Map(a.checks.map((c) => [c.id, c]));
  const checksB = new Map(b.checks.map((c) => [c.id, c]));
  const checks: CheckSetDiff['checks'] = { added: [], removed: [], changed: [], renamed: [], unchanged: [] };
  const added: Check[] = [];
  const removed: Check[] = a.checks.filter((c) => !checksB.has(c.id));
  for (const c of b.checks) {
    const old = checksA.get(c.id);
    if (!old) added.push(c);
    else {
      const fields = fieldsChanged(old, c, CHECK_FIELDS);
      if (fields.length) checks.changed.push({ id: c.id, before: checkView(old), after: checkView(c), fields });
      else checks.unchanged.push(c.id);
    }
  }
  // A check whose content is unchanged but whose id is new was renamed, not rewritten.
  for (const c of added) {
    const i = removed.findIndex((r) => sameContent(r) === sameContent(c));
    if (i === -1) checks.added.push(checkView(c));
    else {
      checks.renamed.push({ from: removed[i]!.id, to: c.id });
      removed.splice(i, 1);
    }
  }
  checks.removed.push(...removed.map(checkView));

  const taskChanged = set.some((s) => s.field === 'instruction' || s.field === 'expected outcomes');
  const touched = new Set<string>([
    ...requirements.added.map((r) => r.id),
    ...requirements.changed.map((r) => r.id),
    ...requirements.renamed.map((r) => r.to),
    ...checks.added.map((c) => c.requirement),
    ...checks.changed.flatMap((c) => [c.before.requirement, c.after.requirement]),
    ...checks.removed.map((c) => c.requirement),
    ...checks.renamed.map((r) => checksB.get(r.to)!.requirement),
  ]);
  const toReview = b.requirements.map((r) => r.id).filter((id) => taskChanged || touched.has(id));

  const from = { id: a.id, version: a.version, content: contentDigest(a) };
  const to = { id: b.id, version: b.version, content: contentDigest(b) };
  const reordered = {
    requirements: reorderedIds(a.requirements, b.requirements),
    checks: reorderedIds(a.checks, b.checks),
  };
  return { from, to, identical: from.content === to.content, set, requirements, checks, reordered, toReview };
}

const quoted = (r: RequirementView): Inline => [{ t: r.id, b: true }, ` (${r.kind}): "${r.quote}"`];

/** A check: its description, then what it tests and reads. */
export function checkItem(c: CheckView, extra: ListItem[] = []): ListItem {
  return {
    text: [{ t: c.id, b: true }, ` ${c.description}`],
    items: [
      { text: `tests: ${c.tests}` },
      ...(c.reads.length ? [{ text: `reads: ${c.reads.join(', ')}` }] : []),
      ...c.settings.map((s) => ({ text: s })),
      ...extra,
    ],
  };
}

function changedCheck(c: Changed<CheckView>): ListItem {
  const items: ListItem[] = [];
  const pair = (label: string, x: string, y: string) =>
    items.push({ text: `${label}:`, items: [{ text: `before: ${x}` }, { text: `after: ${y}` }] });
  if (c.before.description !== c.after.description) pair('description', c.before.description, c.after.description);
  if (c.before.tests !== c.after.tests) pair('what it tests', c.before.tests, c.after.tests);
  else if (c.fields.includes('what it tests'))
    // Same plain-language rendering, different JSON (e.g. a whitespace in a pattern).
    items.push({ text: 'what it tests: changed in a detail the plain-language rendering does not show' });
  if (c.before.requirement !== c.after.requirement) pair('requirement', c.before.requirement, c.after.requirement);
  const settings = (v: CheckView) => v.settings.join('; ') || 'none';
  if (settings(c.before) !== settings(c.after)) pair('settings', settings(c.before), settings(c.after));
  return { text: [{ t: c.id, b: true }, ` (${c.after.requirement}) changed: ${c.fields.join(', ')}`], items };
}

/** The diff as review-sheet blocks (a heading per section). */
export function diffBlocks(d: CheckSetDiff, level: 2 | 3 = 2): Block[] {
  const blocks: Block[] = [];
  const sub = (level + 1) as 2 | 3;
  if (d.identical) {
    blocks.push({ p: `No changes from ${d.from.id} v${d.from.version}.` });
    return blocks;
  }
  if (d.set.length)
    blocks.push({
      ul: d.set.map((s) =>
        s.before !== undefined && s.after !== undefined && s.before.length + s.after.length < 80
          ? { text: `${s.field}: ${s.before} → ${s.after}` }
          : {
              text: `${s.field} changed:`,
              items: [{ text: `before: ${s.before ?? '(none)'}` }, { text: `after: ${s.after ?? '(none)'}` }],
            },
      ),
    });
  const r = d.requirements;
  const reqItems: ListItem[] = [
    ...r.added.map((x) => ({ text: cat('added ', quoted(x)), items: [{ text: x.text }] })),
    ...r.removed.map((x) => ({ text: cat('removed ', quoted(x)) })),
    ...r.renamed.map((x) => ({ text: `renamed ${x.from} → ${x.to} (unchanged otherwise)` })),
    ...(d.reordered.requirements ? [{ text: 'reordered (the order of results changes)' }] : []),
    ...r.changed.map((x) => ({
      text: cat({ t: x.id, b: true }, ` changed: ${x.fields.join(', ')}`),
      items: [
        ...(x.before.kind !== x.after.kind ? [{ text: `kind: ${x.before.kind} → ${x.after.kind}` }] : []),
        ...(x.before.quote !== x.after.quote || x.before.field !== x.after.field
          ? [
              {
                text: `source: ${x.before.field} "${x.before.quote}" → ${x.after.field} "${x.after.quote}"`,
              },
            ]
          : []),
        ...(x.before.text !== x.after.text ? [{ text: `text: ${x.before.text} → ${x.after.text}` }] : []),
      ],
    })),
  ];
  if (reqItems.length) blocks.push({ h: sub, text: 'Requirements' }, { ul: reqItems });
  const c = d.checks;
  const checkItems: ListItem[] = [
    ...c.added.map((x) => {
      const item = checkItem(x);
      return { ...item, text: cat('added ', item.text, ` (${x.requirement})`) };
    }),
    ...c.removed.map((x) => {
      const item = checkItem(x);
      return { ...item, text: cat('removed ', item.text, ` (${x.requirement})`) };
    }),
    ...c.changed.map(changedCheck),
    ...c.renamed.map((x) => ({ text: `renamed ${x.from} → ${x.to} (unchanged otherwise)` })),
    ...(d.reordered.checks ? [{ text: 'reordered (the order of results changes)' }] : []),
  ];
  if (checkItems.length) blocks.push({ h: sub, text: 'Checks' }, { ul: checkItems });
  const settled = r.unchanged.filter((id) => !d.toReview.includes(id));
  const unchanged = [
    ...(settled.length ? [`requirements ${settled.join(', ')}`] : []),
    ...(c.unchanged.length ? [`checks ${c.unchanged.join(', ')}`] : []),
  ];
  blocks.push({
    p: [
      { t: 'To re-review:', b: true },
      ` ${
        d.toReview.length
          ? d.toReview.join(', ')
          : r.removed.length || c.removed.length
            ? 'none (requirements or checks were only removed)'
            : 'none (no requirement or check changed)'
      }.`,
      ...(unchanged.length ? [` Unchanged: ${unchanged.join('; ')}.`] : []),
    ],
  });
  return blocks;
}

/** The diff on its own, as Markdown or HTML. */
export function formatCheckSetDiff(d: CheckSetDiff, format: DocFormat = 'markdown'): string {
  const title = `Changes: ${d.from.id} v${d.from.version} → ${d.to.id} v${d.to.version}`;
  return render([{ h: 2, text: title }, ...diffBlocks(d, 2)], format);
}
