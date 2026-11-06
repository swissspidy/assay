/**
 * The compiler (milestone 2): task instruction + expected outcomes + reference
 * snapshots → a validated, traceable check set.
 *
 *   1. Rubric: requirements, each quoting the task text (model, or deterministic).
 *   2. Evidence discovery: an agent explores the reference snapshots.
 *   3. Compile: the agent submits DSL checks; submission validates them and runs
 *      them against every reference, and the agent repairs until accepted.
 *
 * Models run only here. The output is data that runs without one.
 */
import type {
  Assertion,
  AXNode,
  Check,
  CheckSet,
  EvidenceSnapshot,
  Json,
  Normalizer,
  Requirement,
  Channel,
  Trust,
  ValueSource,
} from '../types.ts';
import { CHECKS_SCHEMA, CHANNEL_TRUST } from '../types.ts';
import { MAX_TOLERANCE, checkSetSchema } from '../dsl/schema.ts';
import {
  looseMatches,
  pickOnSameShape,
  readsRoute,
  routeOnly,
  sameCollection,
  usesPick,
  validateCheckSet,
} from '../dsl/validate.ts';
import {
  bindingSides,
  evaluate,
  evaluateAssertion,
  pageContext,
  readValue,
  type EvalCtx,
} from '../runtime/evaluate.ts';
import { compareValues, tolerable } from '../runtime/compare.ts';
import { describeValue, type TypedValue } from '../runtime/values.ts';
import { scalarOf } from '../stress/mutants.ts';
import { AXIndex, resolveTarget } from '../runtime/axindex.ts';
import { canonical } from '../text.ts';
import { ASSAY_VERSION } from '../version.ts';
import { runAgent, type AgentTool, type AgentRun } from '../model/agent.ts';
import type { ModelClient, ModelMode } from '../model/types.ts';
import { noModelError, resolveModel, type ModelInput, type ModelOptions } from '../model/resolve.ts';
import { loadConfig, normalizeConfig, type AssayConfig } from '../config/config.ts';
import { parseOutcomes, parseOutcomesDetailed, type Clause } from './outcomes.ts';
import { stressTest, type FindingRef } from '../stress/stress.ts';
import { findNodes, networkEntry, networkLog, outline, probesView, storageView, summary } from './explore.ts';
import {
  DISCOVERY_ABSENCE,
  DISCOVERY_BASELINE,
  DISCOVERY_FORMS,
  DISCOVERY_FRAMES,
  DISCOVERY_NUDGE,
  DISCOVERY_PAGES,
  DISCOVERY_SYSTEM,
  DISCOVERY_TOLERANCE,
  RUBRIC_SYSTEM,
} from './prompts.ts';

export interface TaskInput {
  id: string;
  instruction: string;
  /** Expected outcomes: Gherkin "Then" clauses, a Markdown list, or plain lines. */
  outcomes?: string;
  /**
   * Generic stress variants that are not valid for this task, e.g. "extra-row"
   * when the task fixes the number of items, "reorder" when it asks for an order.
   */
  skipVariants?: string[];
}

export interface Reference {
  name: string;
  /** "success": a correct run (checks must succeed). "negative": an incorrect run (checks must not succeed). */
  kind: 'success' | 'negative';
  snapshot: EvidenceSnapshot;
  /**
   * How this run did the task, in a few words ("through the block editor"), shown to the
   * compiler. Useful when several correct references took different routes (ADR 0011).
   */
  note?: string;
}

export interface CompileOptions {
  /**
   * The model: a `ModelClient`, an AI SDK model, an adapter or a `'provider:model'` string
   * (ADR 0017). Default: `model` from assay.config.ts.
   */
  model?: ModelInput;
  /** How to drive and name the model (merged over the config's `modelOptions` when the model comes from it). */
  modelOptions?: ModelOptions;
  /**
   * A config to take the model from when `model` is not given: an object or a file path
   * (`loadConfig()` finds the project's). Default: none; compileTask never reads
   * assay.config.* by itself.
   */
  config?: AssayConfig | string | false;
  /** "model" (default) asks the model for the rubric; "deterministic" makes one hard requirement per outcome clause. */
  rubric?: 'model' | 'deterministic';
  /**
   * Use these (already confirmed) requirements instead of deriving a rubric, e.g.
   * when recompiling checks for a locked set: only the checks change.
   */
  requirements?: Requirement[];
  /**
   * Optional agent trajectory (actions, notes). Context only: it helps the
   * agent know where to look, it is never evidence.
   */
  trajectory?: string;
  maxTurns?: number;
  log?: (msg: string) => void;
  /**
   * Provenance written to the compiled set (`compiled`). `model` defaults to the
   * model client's id and `at` to now; a replayed compile passes the recording's.
   */
  provenance?: { model?: string; at?: string };
}

export interface RequirementCoverage {
  requirement: string;
  quote: string;
  checks: string[];
  channels: Channel[];
  /**
   * How hard the requirement is to fake: the strongest of its checks, where an
   * anyOf counts as its weakest branch. "freetext" coverage is flagged.
   */
  trust: Trust | null;
  /**
   * Every check reads only route evidence (requests, responses, the URL) of the way the
   * references did the task, and at least one reads the network (ADR 0011). A run that
   * does it another way leaves nothing for them to read. Absent when false.
   */
  routeOnly?: true;
}

export interface CompileReport {
  task: string;
  status: 'compiled' | 'failed';
  reason?: string;
  model: string;
  modelsUsed: string[];
  /**
   * How the model was driven, when a turn was not native tool calling (ADR 0017): absent
   * means every turn used the provider's tools.
   */
  modes?: ModelMode[];
  turns: { rubric: number; discovery: number };
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  coverage: RequirementCoverage[];
  warnings: string[];
  references: { name: string; kind: Reference['kind']; verdict: string }[];
}

export interface CompileResult {
  checkSet?: CheckSet;
  report: CompileReport;
}

// ---------------------------------------------------------------------------
// Rubric
// ---------------------------------------------------------------------------

const fold = (s: string) => canonical(s).toLowerCase();

export function rubricFromClauses(task: TaskInput): Requirement[] {
  const clauses = parseOutcomes(task.outcomes);
  if (!clauses.length) {
    return [
      { id: 'R1', kind: 'hard', text: task.instruction, source: { field: 'instruction', quote: task.instruction } },
    ];
  }
  return clauses.map((c, i) => ({
    id: `R${i + 1}`,
    kind: 'hard',
    text: c.text,
    source: { field: 'outcomes', quote: c.text },
  }));
}

const OPTIONAL = /\b(optional(ly)?|if possible|ideally|nice to have|if you can|bonus)\b/i;
const MARKER = '(?:optional(?:ly)?|if possible|ideally|nice to have|if you can|bonus)';
const LEADING_OPTIONAL = new RegExp(`^(?:(?:then|and|but)\\s+)?${MARKER}\\b`, 'i');
const TRAILING_OPTIONAL = new RegExp(`\\b${MARKER}[.!]?$`, 'i');
/** Anything that can join two parts of a quote: punctuation, a spaced dash, a sentence end, a conjunction. */
const SEPARATOR = /[,;:.!?]|\s[–—-]\s|\b(?:and|but|then|while|whereas|although|though|whilst|unless|except)\b/i;
/** Any negation. Near optional wording it may mean the opposite ("not just optional"), so it never relaxes. */
const NEGATION = /\b(?:not|never|no longer|neither|nor)\b|n['’]t\b/i;

/**
 * Whether the quote says something is optional. This is deliberately conservative:
 * a quote with any negation in it does not count, so it can only be hard.
 */
export const hasOptionalWording = (quote: string) => {
  const q = canonical(quote);
  return OPTIONAL.test(q) && !NEGATION.test(q);
};

/**
 * Whether the optional wording qualifies the whole quote. Only three simple
 * shapes count: the wording opens a single part ("ideally, gift wrap it"),
 * closes a single part ("a gift note if possible"), or follows one part after
 * a comma or dash ("ships express, if possible"). Anything with a second part
 * ("ships express; receipt optional", "ideally a note, but express is
 * required") is a mixed quote and must be split. Being conservative can only
 * make a requirement stricter, never drop a mandatory part.
 */
export function wholeQuoteOptional(quote: string): boolean {
  if (!hasOptionalWording(quote)) return false;
  const q = canonical(quote)
    .replace(/[.!?]+$/, '')
    .trimEnd();
  const lead = LEADING_OPTIONAL.exec(q);
  if (lead) return !SEPARATOR.test(q.slice(lead[0].length).replace(/^[\s,:–—-]+/, ''));
  const m = TRAILING_OPTIONAL.exec(q);
  if (!m) return false;
  const before = q
    .slice(0, m.index)
    .trimEnd()
    .replace(/\s*[,–—-]$/, '');
  return !SEPARATOR.test(before);
}
/** Letters, digits and combining marks (a vowel sign continues its word). */
const WORD = /[\p{L}\p{N}\p{M}]/u;

/** Whether `needle` occurs in `hay` at word boundaries ("pay" is not in "repay"). */
function includesWords(hay: string, needle: string): boolean {
  if (!needle) return false;
  // Compare whole code points: an astral letter is two UTF-16 units, neither a WORD on its own.
  const chars = [...needle];
  const first = chars[0]!;
  const last = chars.at(-1)!;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = Array.from(hay.slice(Math.max(0, i - 2), i)).at(-1) ?? '';
    const after = Array.from(hay.slice(i + needle.length, i + needle.length + 2))[0] ?? '';
    const edge = (ch: string, inner: string) => !ch || !WORD.test(ch) || !WORD.test(inner);
    if (edge(before, first) && edge(after, last)) return true;
  }
  return false;
}

/** Whether `quote` contains the whole clause, at word boundaries. */
export function containsClause(quote: string, clause: string): boolean {
  return includesWords(fold(quote), fold(clause));
}

/** Whether `quote` is a part of the clause (possibly all of it), at word boundaries. */
export function partOfClause(quote: string, clause: string): boolean {
  return includesWords(fold(clause), fold(quote));
}

/**
 * Whether the quotes together cover every word of the clause: one quote contains
 * it, or the parts quoted by several requirements leave no word out. A quote that
 * drops a word ("the order ships" for "the order ships express") covers nothing on
 * its own.
 */
export function clauseCovered(quotes: string[], clause: string): boolean {
  const c = fold(clause);
  if (quotes.some((q) => containsClause(q, clause))) return true;
  const mask = Array.from({ length: c.length }, () => false);
  for (const q of quotes) {
    const fq = fold(q);
    if (!fq) continue;
    for (let i = c.indexOf(fq); i !== -1; i = c.indexOf(fq, i + 1)) mask.fill(true, i, i + fq.length);
  }
  // The mask uses UTF-16 offsets (indexOf); step through code points but index by offset.
  let offset = 0;
  return [...c].every((ch) => {
    const covered = mask[offset] || !WORD.test(ch);
    offset += ch.length;
    return covered;
  });
}

/** True when the quote alone covers every word of the clause. */
export function coversClause(quote: string, clause: string): boolean {
  return clauseCovered([quote], clause);
}

/**
 * Errors that make a rubric unusable: empty or untraceable quotes, duplicate
 * ids, one requirement merging several outcome clauses, a requirement marked
 * soft although its quote does not say it is optional, outcome clauses whose
 * words are not all quoted.
 */
export function checkRubric(task: TaskInput, reqs: Requirement[], clauses: Clause[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  // Identical clauses are one outcome.
  const unique = clauses.filter((c, i) => clauses.findIndex((d) => fold(d.text) === fold(c.text)) === i);
  if (!reqs.length) errors.push('No requirements.');
  if (!reqs.some((r) => r.kind === 'hard')) errors.push('At least one requirement must be hard.');
  for (const r of reqs) {
    if (ids.has(r.id)) errors.push(`Duplicate requirement id ${r.id}.`);
    ids.add(r.id);
    if (!canonical(r.text)) errors.push(`${r.id}: text is empty.`);
    if (!canonical(r.source.quote)) {
      errors.push(`${r.id}: quote is empty.`);
      continue;
    }
    const src = r.source.field === 'instruction' ? task.instruction : (task.outcomes ?? '');
    // Verbatim: only whitespace and Unicode form are normalized, never case.
    if (!canonical(src).includes(canonical(r.source.quote))) {
      errors.push(`${r.id}: quote ${JSON.stringify(r.source.quote)} is not verbatim in the ${r.source.field}.`);
      continue;
    }
    // Soft requirements never fail a run, so only text that says it is optional may be soft.
    if (r.kind === 'soft' && !hasOptionalWording(r.source.quote)) {
      errors.push(
        `${r.id}: ${JSON.stringify(r.source.quote)} is marked soft, but the quoted words do not say it is optional; make it hard.`,
      );
    } else if (hasOptionalWording(r.source.quote) && (r.kind === 'hard' || !wholeQuoteOptional(r.source.quote))) {
      // "ships express, ideally with a receipt": the optional word covers only what follows it.
      // As soft, the mandatory part could never fail a run; as hard, the optional part could.
      errors.push(
        r.kind === 'hard' && wholeQuoteOptional(r.source.quote)
          ? `${r.id}: ${JSON.stringify(r.source.quote)} says it is optional; make it soft.`
          : `${r.id}: ${JSON.stringify(r.source.quote)} mixes a mandatory and an optional part; quote the mandatory part as a hard requirement and only the optional part (with its optional wording) as soft.`,
      );
    }
    if (r.source.field !== 'outcomes') continue;
    // Clauses this quote merges; a clause nested inside another merged clause does not count separately.
    const merged = unique.filter((c) => containsClause(r.source.quote, c.text));
    const outer = merged.filter((c) => !merged.some((d) => d !== c && containsClause(d.text, c.text)));
    if (outer.length > 1) {
      errors.push(`${r.id}: its quote spans ${outer.length} expected outcomes; make one requirement per outcome.`);
      continue;
    }
  }
  const quotes = reqs
    .filter((r) => r.source.field === 'outcomes' && canonical(r.source.quote))
    .map((r) => r.source.quote);
  for (const c of unique) {
    if (!clauseCovered(quotes, c.text))
      errors.push(
        `Expected outcome ${JSON.stringify(c.text)} is not fully quoted by any requirement (every word must be covered).`,
      );
  }
  return errors;
}

const RUBRIC_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'text', 'field', 'quote'],
        properties: {
          id: { type: 'string', pattern: '^R[0-9]+$' },
          kind: { type: 'string', enum: ['hard', 'soft'] },
          text: { type: 'string', minLength: 1 },
          field: { type: 'string', enum: ['instruction', 'outcomes'] },
          quote: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

async function modelRubric(
  task: TaskInput,
  model: ModelClient,
  maxTurns: number,
): Promise<{ run: AgentRun<Requirement[]>; requirements?: Requirement[] }> {
  const clauses = parseOutcomes(task.outcomes);
  const prompt = [
    `Task instruction:\n<instruction>\n${task.instruction}\n</instruction>`,
    task.outcomes
      ? `Expected outcomes:\n<outcomes>\n${task.outcomes}\n</outcomes>`
      : 'No expected outcomes were given.',
    clauses.length ? `Parsed outcome clauses:\n${clauses.map((c) => `- ${c.text}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const submit: AgentTool<Requirement[]> = {
    spec: {
      name: 'submit_rubric',
      description:
        'Submit the requirements. Rejected with reasons if a quote is not verbatim or an outcome is uncovered.',
      inputSchema: RUBRIC_TOOL_SCHEMA,
      strict: true,
    },
    run(input: {
      requirements: {
        id: string;
        kind: 'hard' | 'soft';
        text: string;
        field: 'instruction' | 'outcomes';
        quote: string;
      }[];
    }) {
      const reqs: Requirement[] = input.requirements.map((r) => ({
        id: r.id,
        kind: r.kind,
        text: r.text,
        source: { field: r.field, quote: r.quote },
      }));
      const errors = checkRubric(task, reqs, clauses);
      if (errors.length) return { content: `Rejected:\n- ${errors.join('\n- ')}`, isError: true };
      return { content: 'Accepted.', done: reqs };
    },
  };
  const run = await runAgent({ model, system: RUBRIC_SYSTEM, prompt, tools: [submit], maxTurns });
  return { run, ...(run.result ? { requirements: run.result } : {}) };
}

// ---------------------------------------------------------------------------
// Discovery and compilation
// ---------------------------------------------------------------------------

const TRUST_RANK: Record<Trust, number> = { freetext: 1, semantic: 2, structured: 3 };
const RANK_TRUST: Trust[] = ['freetext', 'freetext', 'semantic', 'structured'];

function sourceChannel(src: ValueSource): Channel {
  const f = src.from;
  return f === 'node' ? 'a11y' : f === 'request' || f === 'response' ? 'network' : f === 'text' ? 'text' : f;
}

function sourceChannels(a: Assertion): Channel[] {
  switch (a.kind) {
    case 'state':
    case 'contains':
      return ['a11y'];
    case 'url':
      return ['url'];
    case 'request':
      return ['network'];
    case 'value':
      return [...new Set([a.source, ...('sameAs' in a.expect ? [a.expect.sameAs.source] : [])].map(sourceChannel))];
    case 'each':
      return [...new Set(['a11y' as const, ...sourceChannels(a.assert)])];
    case 'page':
      return sourceChannels(a.assert);
    case 'allOf':
    case 'anyOf':
      return [...new Set(a.of.flatMap(sourceChannels))];
  }
}

/**
 * How hard an assertion is to satisfy by faking page content. `anyOf` is as weak
 * as its weakest branch (that branch alone can pass); `allOf` as strong as its
 * strongest part (every part must pass); a `sameAs` binding as its weaker source.
 */
export function assertionTrust(a: Assertion): number {
  switch (a.kind) {
    case 'anyOf':
      return Math.min(...a.of.map(assertionTrust));
    case 'allOf':
      return Math.max(...a.of.map(assertionTrust));
    case 'each':
      // Records are found in the accessibility tree; what is read inside them can be weaker.
      return Math.min(TRUST_RANK.semantic, assertionTrust(a.assert));
    case 'page':
      return assertionTrust(a.assert);
    default:
      // A sameAs binding passes when one side is made to show what the other holds, so
      // faking the weaker side alone is enough: it counts as its weaker source.
      return Math.min(...sourceChannels(a).map((c) => TRUST_RANK[CHANNEL_TRUST[c]]));
  }
}

/** Per requirement: its checks, channels, and trust (all checks must pass, so the strongest check counts). */
export function coverage(cs: CheckSet): RequirementCoverage[] {
  return cs.requirements.map((r) => {
    const checks = cs.checks.filter((c) => c.requirement === r.id);
    const channels = [...new Set(checks.flatMap((c) => sourceChannels(c.assert)))];
    const rank = checks.length ? Math.max(...checks.map((c) => assertionTrust(c.assert))) : 0;
    return {
      requirement: r.id,
      quote: r.source.quote,
      checks: checks.map((c) => c.id),
      channels,
      trust: rank ? RANK_TRUST[rank]! : null,
      ...(routeOnlyRequirement(checks) ? { routeOnly: true as const } : {}),
    };
  });
}

/**
 * The checks read only route evidence, at least one of them from the network. A view's
 * URL alone is not counted: for "show me …" the URL is the state of the view.
 */
function routeOnlyRequirement(checks: Check[]): boolean {
  return (
    checks.length > 0 &&
    checks.every((c) => routeOnly(c.assert)) &&
    checks.some((c) => sourceChannels(c.assert).includes('network'))
  );
}

interface Verification {
  errors: string[];
  warnings: string[];
  references: CompileReport['references'];
}

/** Validate a candidate check set and run it against every reference. */
/**
 * Validate a candidate check set, run it against every reference and (unless
 * `stress` is false) stress-test it on the correct references: failing or
 * abstaining on a valid variant is an error (over-constrained or fragile); weak
 * checks and missed mutants are warnings.
 */
/** The contexts of every record an `each` finds, in each of `ctxs`. */
function recordContexts(ctxs: EvalCtx[], a: Extract<Assertion, { kind: 'each' }>): EvalCtx[] {
  return ctxs.flatMap((ctx) => {
    let scope = ctx.record ?? ctx.index.root;
    if (a.scope) {
      const r = resolveTarget(ctx.index, a.scope, scope);
      if (!r.ok) return [];
      scope = r.node;
    }
    return ctx.index.records(a.match, scope).map((record) => ({ ...ctx, record }));
  });
}

/**
 * anyOf branches that abstain on every correct reference. Such a branch was never
 * seen to read its evidence, and on an incorrect run it turns the check's fail
 * into an abstain (fail OR abstain is abstain), so it is refused.
 */
export function unreadableBranches(cs: CheckSet, refs: Reference[]): string[] {
  const top: EvalCtx[] = refs
    .filter((r) => r.kind === 'success')
    .map((r) => ({ snapshot: r.snapshot, index: new AXIndex(r.snapshot.a11y) }));
  if (!top.length) return [];
  const errors: string[] = [];
  const walk = (check: string, a: Assertion, path: string, ctxs: EvalCtx[]) => {
    if (a.kind === 'each') {
      // Inside an each, a branch is read in every record of every correct run.
      const inner = recordContexts(ctxs, a);
      if (inner.length) walk(check, a.assert, `${path}.assert`, inner);
      return;
    }
    if (a.kind !== 'anyOf' && a.kind !== 'allOf') return;
    a.of.forEach((b, i) => {
      const at = `${path}.of[${i}]`;
      if (a.kind === 'anyOf') {
        const results = ctxs.map((ctx) => evaluateAssertion(ctx, b));
        if (results.every((r) => r.status === 'abstain')) {
          const reasons = [...new Set(results.map((r) => r.reason ?? r.message))].join(', ');
          errors.push(
            `${check}: anyOf branch ${at} abstains on every correct run (${reasons}). A branch whose evidence never exists turns a fail into an abstain; remove it or point it at evidence the correct runs have.`,
          );
          return;
        }
      }
      walk(check, b, at, ctxs);
    });
  };
  for (const c of cs.checks)
    walk(c.id, c.assert, 'assert', c.onMissing === 'abstain' ? top.map((x) => ({ ...x, routeMissing: true })) : top);
  return errors;
}

// ---------------------------------------------------------------------------
// Route evidence (ADR 0011)
// ---------------------------------------------------------------------------

/** The leaves of an assertion outside `each` records, with their paths. */
function topLeaves(a: Assertion, at: string): { a: Assertion; at: string }[] {
  if (a.kind === 'allOf' || a.kind === 'anyOf') return a.of.flatMap((b, i) => topLeaves(b, `${at}.of[${i}]`));
  if (a.kind === 'each') return [];
  return [{ a, at }];
}

/**
 * Checks without `onMissing: "abstain"` whose route evidence (a request, a URL, a value
 * read from the network) is missing on some correct reference while the check passes
 * there. With references that did the task by different routes, such a leaf is route
 * evidence by construction, and a run that takes yet another route would fail on it.
 */
export function unmarkedRouteChecks(cs: CheckSet, refs: Reference[]): string[] {
  const ok = refs.filter((r) => r.kind === 'success');
  const errors: string[] = [];
  for (const c of cs.checks) {
    if (c.onMissing === 'abstain' || !readsRoute(c.assert)) continue;
    const found = new Set<string>();
    for (const leaf of topLeaves(c.assert, 'assert')) {
      if (!readsRoute(leaf.a)) continue;
      for (const r of ok) {
        const res = evaluateAssertion(
          { snapshot: r.snapshot, index: new AXIndex(r.snapshot.a11y), routeMissing: true },
          leaf.a,
        );
        if (res.reason === 'route_missing') found.add(`${leaf.at} on "${r.name}"`);
      }
    }
    if (found.size)
      errors.push(
        `${c.id} reads route evidence that a correct run does not have (${[...found].join(', ')}): it shows one way of doing the task, so a run that does it yet another way would fail. Set "onMissing": "abstain" on ${c.id}.`,
      );
  }
  return errors;
}

/** Runs of at least six literal characters (with a letter) in a regular expression. */
export function literalRuns(pattern: string): string[] {
  const runs: string[] = [];
  let cur = '';
  const end = () => {
    if (cur.trim()) runs.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[++i] ?? '';
      // Classes, anchors, escapes of control characters (\n, \t, …) and back-references end a run.
      if (/[sSdDwWbBpPuxkcntrfv0-9]/.test(next)) end();
      else cur += next;
    } else if (ch === '[') {
      end();
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
    } else if ('?*{'.includes(ch)) {
      // The character before an optional quantifier may be absent.
      cur = cur.slice(0, -1);
      end();
      if (ch === '{') while (i < pattern.length && pattern[i] !== '}') i++;
    } else if (ch === '(') {
      end();
      // A group's own syntax is not literal: (?:…), (?=…), (?!…), (?<=…), (?<!…), (?<name>…).
      if (pattern[i + 1] === '?') {
        const m = /^\?(?::|=|!|<=|<!|P?<[^>]*>)/.exec(pattern.slice(i + 1));
        if (m) i += m[0].length;
      }
    } else if ('^$.+)|'.includes(ch)) end();
    else cur += ch;
  }
  end();
  return runs.filter((x) => x.length >= 6 && /\p{L}/u.test(x));
}

/** The literal strings a check compares route evidence with (bodies, values, patterns). */
function comparedLiterals(a: Assertion): string[] {
  const out: string[] = [];
  const str = (x: unknown) => {
    if (typeof x === 'string' && x.length >= 6 && /\p{L}/u.test(x)) out.push(x);
  };
  const schema = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(schema);
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'const') str(v);
      else if (k === 'enum' && Array.isArray(v)) v.forEach(str);
      else if (k === 'pattern' && typeof v === 'string') out.push(...literalRuns(v));
      else schema(v);
    }
  };
  for (const { a: leaf } of topLeaves(a, '')) {
    if (leaf.kind === 'request') {
      schema(leaf.match.requestBody);
      schema(leaf.match.responseBody);
    } else if (leaf.kind === 'value' && readsRoute(leaf)) {
      const e = leaf.expect;
      if ('equals' in e) str(e.equals);
      if ('oneOf' in e) e.oneOf.forEach(str);
      if ('contains' in e) str(e.contains);
      if ('regex' in e) out.push(...literalRuns(e.regex));
      if ('schema' in e) schema(e.schema);
    }
  }
  return [...new Set(out)];
}

/**
 * Requirements whose only evidence is route evidence (ADR 0011). Refused when a probe
 * of a correct reference holds a value the route checks compare and did not hold it in
 * the baseline (so the task wrote it): the state is observable independently of the route, so check it
 * there. Otherwise a warning, naming the probes that were captured, so the test author
 * can see which probe lacks the field.
 */
export function routeOnlyFindings(cs: CheckSet, refs: Reference[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ok = refs.filter((r) => r.kind === 'success');
  for (const r of cs.requirements) {
    const checks = cs.checks.filter((c) => c.requirement === r.id);
    if (!routeOnlyRequirement(checks)) continue;
    const literals = checks.flatMap((c) => comparedLiterals(c.assert));
    const probes = new Set<string>();
    const held: string[] = [];
    for (const ref of ok) {
      for (const [name, p] of Object.entries(ref.snapshot.probes ?? {})) {
        if (!p.ok) continue;
        probes.add(name);
        const after = JSON.stringify(p.value).toLowerCase();
        // Without a baseline, a probe value may have been there before the task: no refusal.
        // A probe that failed in the baseline read nothing then (its record did not exist yet).
        if (!ref.snapshot.baseline) continue;
        const b = ref.snapshot.baseline.probes[name];
        const before = b?.ok ? JSON.stringify(b.value).toLowerCase() : '';
        for (const lit of literals) {
          const l = JSON.stringify(lit).slice(1, -1).toLowerCase();
          if (after.includes(l) && !before.includes(l)) held.push(`probe ${name} holds ${JSON.stringify(lit)}`);
        }
      }
    }
    const routeChecks = checks.map((c) => c.id).join(', ');
    if (held.length) {
      errors.push(
        `Requirement ${r.id} is checked only through route evidence (${routeChecks}: requests or the URL of the way the reference did it), but ${[...new Set(held)].join('; ')} after the task. Check the stored state in that probe; the route checks may stay, with "onMissing": "abstain".`,
      );
    } else {
      warnings.push(
        `Requirement ${r.id} has no evidence independent of the reference's route: ${routeChecks} read only requests or the URL of the way the reference did it, so a run that does it another way ${checks.every((c) => c.onMissing === 'abstain') ? 'abstains' : 'fails'}. ${probes.size ? `The probes (${[...probes].join(', ')}) do not show it; extending one with this state would make it checkable whatever the route.` : 'No probe was captured; a probe of this state would make it checkable whatever the route.'}`,
      );
    }
  }
  return { errors, warnings };
}

/** Steps with every items `pick` removed: whole items, filtered and sorted. */
const withoutPick = (steps: Normalizer[] | undefined): Normalizer[] =>
  (steps ?? []).map((s) => {
    if (typeof s !== 'object' || s.op !== 'items') return s;
    const { pick: _, ...rest } = s;
    return rest;
  });

/** The field names of a collection's items, or undefined unless it is a non-empty array of objects. */
function shapesOf(v: Json | undefined): string[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    out.push(JSON.stringify(Object.keys(item).toSorted()));
  }
  return out;
}

/**
 * sameAs comparisons through items `pick` whose two collections, in every correct
 * reference where both can be read, hold items with exactly the same fields (also inside
 * the records of an `each`). pick drops fields, so it is for collections of different
 * shapes; on one shape, whole items compare every field. One collection before and after
 * is caught statically when both sides name it the same way, and here when one side
 * leaves a storage origin to the page.
 */
export function pickOnSameShapes(cs: CheckSet, refs: Reference[]): string[] {
  const top: EvalCtx[] = refs
    .filter((r) => r.kind === 'success')
    .map((r) => ({ snapshot: r.snapshot, index: new AXIndex(r.snapshot.a11y) }));
  const errors: string[] = [];
  const walk = (a: Assertion, at: string, ctxs: EvalCtx[]): void => {
    if (a.kind === 'allOf' || a.kind === 'anyOf') return a.of.forEach((b, i) => walk(b, `${at}.${a.kind}[${i}]`, ctxs));
    // Inside an each, both sides are read in every record (record text parsed as JSON).
    if (a.kind === 'each') return walk(a.assert, `${at}.assert`, recordContexts(ctxs, a));
    if (a.kind !== 'value' || !('sameAs' in a.expect)) return;
    const other = a.expect.sameAs;
    if (!usesPick(a.normalize) && !usesPick(other.normalize)) return;
    // The validator already reports one collection named the same way on both sides.
    if (sameCollection(a.source, other.source)) return;
    // A storage key without an origin is the page's: the same key named both ways is one collection.
    if (ctxs.some((ctx) => sameCollection(withOrigin(a.source, ctx), withOrigin(other.source, ctx)))) {
      errors.push(pickOnSameShape(at, 'one collection before and after the task'));
      return;
    }
    let seen = 0;
    for (const ctx of ctxs) {
      const x = shapesOf(readValue(ctx, a.source, withoutPick(a.normalize)));
      const y = shapesOf(readValue(ctx, other.source, withoutPick(other.normalize)));
      if (!x || !y) continue;
      if (new Set([...x, ...y]).size !== 1) return;
      seen++;
    }
    if (seen) errors.push(pickOnSameShape(at, 'two collections'));
  };
  for (const c of cs.checks) walk(c.assert, `check ${c.id}`, top);
  return errors;
}

/** A storage source with its origin resolved as the runtime resolves it (the page's when omitted). */
function withOrigin(src: ValueSource, ctx: EvalCtx): ValueSource {
  if (src.from !== 'storage' || src.area === 'cookie') return src;
  try {
    return { ...src, origin: new URL(src.origin ?? ctx.snapshot.page.url).origin };
  } catch {
    return src;
  }
}

/** Every sameAs binding inside `a` (also in each records and allOf/anyOf), with where it is and the contexts it is read in. */
function bindings(
  a: Assertion,
  at: string,
  ctxs: EvalCtx[],
  out: { a: Extract<Assertion, { kind: 'value' }>; at: string; ctxs: EvalCtx[] }[] = [],
) {
  if (a.kind === 'allOf' || a.kind === 'anyOf') a.of.forEach((b, i) => bindings(b, `${at}.${a.kind}[${i}]`, ctxs, out));
  else if (a.kind === 'each') bindings(a.assert, `${at}.assert`, recordContexts(ctxs, a), out);
  else if (a.kind === 'page') {
    // Read on the open page the assertion selects (where it selects exactly one).
    const pages = ctxs.map((ctx) => pageContext(ctx, a.match)).filter((c): c is EvalCtx => !('status' in c));
    bindings(a.assert, `${at}.assert`, pages, out);
  } else if (a.kind === 'value' && 'sameAs' in a.expect) out.push({ a, at, ctxs });
  return out;
}

/** How far apart a binding's two sides are, in their unit, when a tolerance could cover it; else undefined. */
function nearGap(left: TypedValue, right: TypedValue): { diff: number; unit: string } | undefined {
  if (left.type !== right.type || !tolerable(left.type)) return undefined;
  if (left.type === 'money' && right.type === 'money' && left.value.currency !== right.value.currency) return undefined;
  const x = scalarOf(left)!;
  const y = scalarOf(right)!;
  const diff = Math.abs(x - y);
  if (diff === 0) return undefined;
  if (left.type === 'datetime') return diff <= MAX_TOLERANCE.minutes ? { diff, unit: ' minutes' } : undefined;
  if (left.type === 'date') return diff <= MAX_TOLERANCE.days ? { diff, unit: ' days' } : undefined;
  return diff <= MAX_TOLERANCE.rel * Math.abs(y) ? { diff, unit: '' } : undefined;
}

/**
 * sameAs bindings without a tolerance that fail on a correct reference only by a difference
 * a tolerance could cover (DISCOVERY_TOLERANCE), one line each; empty when there are none.
 */
export function toleranceHints(cs: CheckSet, refs: Reference[]): string[] {
  const out: string[] = [];
  for (const ref of refs.filter((r) => r.kind === 'success')) {
    const top: EvalCtx[] = [{ snapshot: ref.snapshot, index: new AXIndex(ref.snapshot.a11y) }];
    for (const c of cs.checks)
      for (const { a, at, ctxs } of bindings(c.assert, `check ${c.id}`, top)) {
        if (!('sameAs' in a.expect) || a.expect.sameAs.tolerance) continue;
        for (const ctx of ctxs) {
          const sides = bindingSides(ctx, a);
          const gap = sides && nearGap(sides.left, sides.right);
          if (!sides || !gap) continue;
          out.push(
            `${at}: on correct run "${ref.name}" the two sides differ by ${+gap.diff.toFixed(6)}${gap.unit} (${describeValue(sides.left)} vs ${describeValue(sides.right)}).`,
          );
          break;
        }
      }
  }
  return [...new Set(out)];
}

/** Two read sides are exactly equal; sides of different types never are (the check abstains there), and never throw. */
const exactlyEqual = ({ left, right }: { left: TypedValue; right: TypedValue }) =>
  left.type === right.type && compareValues(left, right).ok;

/** A tolerance must be needed: some correct reference shows the two sides differ. */
export function unneededTolerances(cs: CheckSet, refs: Reference[]): string[] {
  const top: EvalCtx[] = refs
    .filter((r) => r.kind === 'success')
    .map((r) => ({ snapshot: r.snapshot, index: new AXIndex(r.snapshot.a11y) }));
  const errors: string[] = [];
  for (const c of cs.checks)
    for (const { a, at, ctxs } of bindings(c.assert, `check ${c.id}`, top)) {
      if (!('sameAs' in a.expect) || !a.expect.sameAs.tolerance) continue;
      const read = ctxs.map((ctx) => bindingSides(ctx, a)).filter((x) => x !== undefined);
      if (read.length && read.every(exactlyEqual))
        errors.push(
          `${at}: its tolerance is not needed: the two sides are equal on every correct run. Remove it; a tolerance is only for a difference the references show.`,
        );
    }
  return errors;
}

export function verifyCandidate(cs: CheckSet, refs: Reference[], stress = true, skipVariants?: string[]): Verification {
  const v = validateCheckSet(cs);
  // A warning on an accepted submission ends the discovery run unread, so the loose
  // matches the validator warns about are refused here: the fix is always cheap
  // (equals or an anchored regex; one more "required" name) and never needs new evidence.
  const loose = v.ok ? looseMatches(cs) : [];
  const errors = [...v.errors, ...loose];
  const warnings = v.warnings.filter((w) => !loose.includes(w));
  const references: CompileReport['references'] = [];
  for (const r of cs.requirements) {
    if (!cs.checks.some((c) => c.requirement === r.id)) errors.push(`Requirement ${r.id} has no checks.`);
  }
  if (!v.ok) return { errors, warnings, references };
  for (const ref of refs) {
    const o = evaluate(cs, ref.snapshot);
    references.push({ name: ref.name, kind: ref.kind, verdict: o.verdict });
    if (ref.kind === 'success') {
      for (const c of o.checks.filter((x) => x.status !== 'pass')) {
        errors.push(
          `On correct run "${ref.name}", ${c.check} ${c.status}s${c.reason ? ` (${c.reason})` : ''}: ${c.message}`,
        );
      }
      for (const d of o.drift)
        warnings.push(`On "${ref.name}", ${d.check} has an anchor that matches nothing: ${d.locator}`);
    } else if (o.verdict === 'success') {
      errors.push(
        `On incorrect run "${ref.name}" the check set still reports success; some requirement is not actually tested.`,
      );
    } else if (o.verdict === 'abstain') {
      warnings.push(`On incorrect run "${ref.name}" the verdict is abstain rather than fail.`);
    }
  }
  errors.push(
    ...unreadableBranches(cs, refs),
    ...pickOnSameShapes(cs, refs),
    ...unmarkedRouteChecks(cs, refs),
    ...unneededTolerances(cs, refs),
  );
  const route = routeOnlyFindings(cs, refs);
  errors.push(...route.errors);
  warnings.push(...route.warnings);
  for (const cov of coverage(cs)) {
    if (cov.trust === 'freetext')
      warnings.push(`Requirement ${cov.requirement} is covered only by free page text, which a page can spoof.`);
  }
  const ok = refs.filter((r) => r.kind === 'success');
  if (stress && errors.length === 0 && ok.length) {
    const r = stressTest(
      cs,
      ok.map((x) => ({ name: x.name, snapshot: x.snapshot })),
      { skipVariants: skipVariants ?? [] },
    );
    for (const o of r.overConstrained) {
      errors.push(
        `${o.check} is over-constrained: it rejects valid variants of a correct run (${o.variants.map(show).join('; ')}). Test only what the requirement states.`,
      );
    }
    // Refused like over-constraint: a correct run that only looks different would escalate.
    for (const f of r.fragile) {
      errors.push(
        `${f.check} abstains on valid variants of a correct run (${f.variants.map(show).join('; ')}). Make its anchors and normalizers accept any presentation the requirement allows.`,
      );
    }
    for (const w of r.weak)
      warnings.push(`${w.check} still passes when its own evidence is broken (${w.mutants.map(show).join('; ')}).`);
    if (r.missed.length) warnings.push(`Near-miss runs accepted as success: ${r.missed.map(show).join('; ')}.`);
    for (const a of r.advisories) warnings.push(`Advisory: ${show(a)}`);
  }
  return { errors, warnings, references };
}

const hasFrameContent = (n: AXNode): boolean =>
  (n.role === 'iframe' && !!n.children?.length) || (n.children ?? []).some(hasFrameContent);

/**
 * Sections for evidence beyond a single page's main frame (ADR 0012): frames, other open
 * pages and parsed form bodies, each only when a reference holds it, so the prompt for
 * references without them is unchanged.
 */
function captureSections(snapshots: EvidenceSnapshot[]): string[] {
  const parts: string[] = [];
  if (snapshots.some((s) => hasFrameContent(s.a11y) || s.pages?.some((p) => hasFrameContent(p.a11y))))
    parts.push(DISCOVERY_FRAMES);
  if (snapshots.some((s) => s.pages?.length)) parts.push(DISCOVERY_PAGES);
  if (snapshots.some((s) => s.network?.some((e) => e.requestBodyRaw !== undefined))) parts.push(DISCOVERY_FORMS);
  return parts;
}

/**
 * The DSL definitions the compiler's tools take. The `page` assertion (ADR 0012) is offered
 * only when a reference has other open pages, and a sameAs `tolerance` (ADR 0014) only once
 * a submission shows a binding that one could be for (DISCOVERY_TOLERANCE), so the tools
 * (and the recordings keyed on them) change only for such tasks.
 * @internal Exported for tests.
 */
export function dslDefinitions(withPages: boolean, withTolerance = false) {
  const defs = checkSetSchema.definitions;
  const paged = withPages
    ? defs
    : (() => {
        const { pageMatch: _, ...rest } = defs;
        const oneOf = defs.assertion.oneOf.filter(
          (a) => !('const' in a.properties.kind && a.properties.kind.const === 'page'),
        );
        return { ...rest, assertion: { oneOf } };
      })();
  // Same shape either way; only the optional tolerance property is left out.
  return (withTolerance ? paged : withoutTolerance(paged)) as typeof paged;
}

/** The definitions without sameAs tolerance: byte for byte the DSL before it existed. */
function withoutTolerance<D extends object>(defs: D): Record<string, unknown> {
  const d = structuredClone(defs) as unknown as Record<string, Record<string, unknown>>;
  delete d.tolerance;
  const comparison = d.comparison as {
    oneOf: { properties: Record<string, { properties: Record<string, unknown> }> }[];
  };
  for (const alt of comparison.oneOf) delete alt.properties.sameAs?.properties.tolerance;
  return d;
}

/** @internal Exported for tests: the submit_checks input schema. */
export const checksToolSchema = (withPages: boolean, withTolerance = false) => ({
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: { checks: { type: 'array', minItems: 1, items: { $ref: '#/definitions/check' } } },
  definitions: dslDefinitions(withPages, withTolerance),
});

/** @internal Exported for tests: the try_assertion input schema. */
export const assertToolSchema = (withPages: boolean, withTolerance = false) => ({
  type: 'object',
  additionalProperties: false,
  required: ['assert'],
  properties: {
    assert: { $ref: '#/definitions/assertion' },
    onMissing: { enum: ['fail', 'abstain'], description: 'Evaluate as a check with this onMissing setting.' },
  },
  definitions: dslDefinitions(withPages, withTolerance),
});

const show = (f: FindingRef) => `${f.description} [${f.reference}/${f.id}]`;

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties: props,
  required,
});

function discoveryTools(
  task: TaskInput,
  requirements: Requirement[],
  refs: Reference[],
  onAccept: (v: Verification) => void,
) {
  const refNames = refs.map((r) => r.name);
  const withPages = refs.some((r) => r.snapshot.pages?.length);
  const pickRef = (name: string | undefined): Reference => refs.find((r) => r.name === name) ?? refs[0]!;
  const refProp = {
    reference: { type: 'string', enum: refNames, description: 'Reference snapshot name (default: the first one).' },
  };
  type In<T> = T & { reference?: string };
  /** Whether submit_checks and try_assertion accept a sameAs tolerance yet (see toleranceHints). */
  let offered = false;

  const tools: AgentTool<CheckSet>[] = [
    {
      spec: {
        name: 'page_outline',
        description: 'Accessibility tree of a reference snapshot, as an indented outline.',
        inputSchema: obj(refProp),
      },
      run: (i: In<object>) => ({
        content: `${summary(pickRef(i.reference).snapshot)}\n\n${outline(pickRef(i.reference).snapshot)}`,
      }),
    },
    {
      spec: {
        name: 'find_nodes',
        description: 'Find accessibility nodes by role and/or case-insensitive substrings of name or descendant text.',
        inputSchema: obj({ ...refProp, role: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' } }),
      },
      run: (i: In<{ role?: string; name?: string; text?: string }>) => ({
        content: findNodes(pickRef(i.reference).snapshot, i),
      }),
    },
    {
      spec: {
        name: 'network_log',
        description:
          'List recorded requests (document/fetch/XHR by default; allTypes adds scripts, images, …), optionally filtered by method or a URL substring. Request checks match every type.',
        inputSchema: obj({
          ...refProp,
          method: { type: 'string' },
          pathContains: { type: 'string' },
          allTypes: { type: 'boolean' },
          offset: { type: 'integer', minimum: 0, description: 'Skip this many matching rows (for paging).' },
        }),
      },
      run: (i: In<{ method?: string; pathContains?: string; allTypes?: boolean; offset?: number }>) => ({
        content: networkLog(pickRef(i.reference).snapshot, i),
      }),
    },
    {
      spec: {
        name: 'network_entry',
        description: 'Show one request with headers and request/response bodies.',
        inputSchema: obj({ ...refProp, seq: { type: 'integer' } }, ['seq']),
      },
      run: (i: In<{ seq: number }>) => ({ content: networkEntry(pickRef(i.reference).snapshot, i.seq) }),
    },
    {
      spec: { name: 'storage', description: 'Cookies, localStorage and sessionStorage.', inputSchema: obj(refProp) },
      run: (i: In<object>) => ({ content: storageView(pickRef(i.reference).snapshot) }),
    },
    {
      spec: { name: 'probes', description: 'Results of the read-only backend probes.', inputSchema: obj(refProp) },
      run: (i: In<object>) => ({ content: probesView(pickRef(i.reference).snapshot) }),
    },
    {
      spec: {
        name: 'try_assertion',
        description:
          'Evaluate one assertion against every reference snapshot and report pass/fail/abstain with the reason.',
        inputSchema: assertToolSchema(withPages),
      },
      run(i: { assert: Assertion; onMissing?: 'fail' | 'abstain' }) {
        const lines = refs.map((r) => {
          const res = evaluateAssertion(
            {
              snapshot: r.snapshot,
              index: new AXIndex(r.snapshot.a11y),
              ...(i.onMissing === 'abstain' ? { routeMissing: true } : {}),
            },
            i.assert,
          );
          return `${r.name} (${r.kind}): ${res.status}${res.reason ? ` (${res.reason})` : ''} — ${res.message}`;
        });
        return { content: lines.join('\n') };
      },
    },
    {
      spec: {
        name: 'submit_checks',
        description:
          'Submit the complete list of checks. They are validated and run against all references; you get errors to fix, or acceptance.',
        inputSchema: checksToolSchema(withPages),
      },
      run(i: { checks: Check[] }) {
        const cs: CheckSet = {
          schema: CHECKS_SCHEMA,
          id: task.id,
          version: '1',
          task: { instruction: task.instruction, ...(task.outcomes !== undefined ? { outcomes: task.outcomes } : {}) },
          requirements,
          checks: i.checks,
        };
        const v = verifyCandidate(cs, refs, true, task.skipVariants);
        if (v.errors.length) {
          // A binding that fails a correct run by a small difference: offer a tolerance from now on.
          const hints = toleranceHints(cs, refs);
          let tolerance = '';
          if (hints.length) {
            tolerance = `\n\n${offered ? 'sameAs differences on correct runs:' : DISCOVERY_TOLERANCE + '\n\nThe differences:'}\n- ${hints.join('\n- ')}`;
            if (!offered) {
              offered = true;
              for (const t of tools)
                if (t.spec.name === 'submit_checks')
                  t.spec = { ...t.spec, inputSchema: checksToolSchema(withPages, true) };
                else if (t.spec.name === 'try_assertion')
                  t.spec = { ...t.spec, inputSchema: assertToolSchema(withPages, true) };
            }
          }
          return {
            content: `Not accepted. Fix these and resubmit all checks:\n- ${v.errors.join('\n- ')}${v.warnings.length ? `\nWarnings:\n- ${v.warnings.join('\n- ')}` : ''}${tolerance}`,
            isError: true,
          };
        }
        onAccept(v);
        return { content: `Accepted.${v.warnings.length ? ` Warnings:\n- ${v.warnings.join('\n- ')}` : ''}`, done: cs };
      },
    },
  ];
  return tools;
}

/**
 * The discovery prompt: the baseline section when a reference has a baseline, and the
 * absence section when none has one or a probe failed in one (ADR 0011), then the frames,
 * pages and form bodies sections where the references hold them (ADR 0012).
 */
export function discoverySystem(refs: Reference[]): string {
  const baseline = refs.some((r) => r.snapshot.baseline);
  const absence = !baseline || refs.some((r) => Object.values(r.snapshot.baseline?.probes ?? {}).some((p) => !p.ok));
  return [
    DISCOVERY_SYSTEM,
    ...(baseline ? [DISCOVERY_BASELINE] : []),
    ...(absence ? [DISCOVERY_ABSENCE] : []),
    ...captureSections(refs.map((r) => r.snapshot)),
  ].join('\n\n');
}

/** The model for a compile: the given one, else the config's (ADR 0017). */
async function compileModel(opts: CompileOptions): Promise<ModelClient> {
  if (opts.model !== undefined) return resolveModel(opts.model, opts.modelOptions ?? {});
  // Only a config passed in: compileTask never reads assay.config.* by itself (ADR 0017).
  const config =
    opts.config === undefined || opts.config === false
      ? {}
      : typeof opts.config === 'object'
        ? normalizeConfig(opts.config, process.cwd(), 'config')
        : (await loadConfig({ path: opts.config })).config;
  if (config.model === undefined) throw noModelError('compileTask', 'pass `model`, or a `config` that sets one');
  return resolveModel(config.model, { ...config.modelOptions, ...opts.modelOptions });
}

export async function compileTask(
  task: TaskInput,
  refs: Reference[],
  opts: CompileOptions = {},
): Promise<CompileResult> {
  // Tools select references by name (an enum in their schemas), so names must be unique.
  const seen = new Set<string>();
  for (const r of refs) {
    if (seen.has(r.name))
      throw new Error(`Duplicate reference name ${JSON.stringify(r.name)}; reference names must be unique.`);
    seen.add(r.name);
  }
  const model = await compileModel(opts);
  const log = opts.log ?? (() => {});
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const models = new Set<string>();
  const modes = new Set<ModelMode>();
  const report: CompileReport = {
    task: task.id,
    status: 'failed',
    model: model.id,
    modelsUsed: [],
    turns: { rubric: 0, discovery: 0 },
    usage,
    coverage: [],
    warnings: [],
    references: [],
  };
  const add = (run: AgentRun<unknown>) => {
    usage.inputTokens += run.usage.inputTokens;
    usage.outputTokens += run.usage.outputTokens;
    usage.cacheReadTokens += run.usage.cacheReadTokens;
    usage.cacheWriteTokens += run.usage.cacheWriteTokens;
    run.models.forEach((m) => models.add(m));
    report.modelsUsed = [...models];
    run.modes.forEach((m) => modes.add(m));
    // Only when a turn was not native tool calling, so earlier reports stay as they were.
    if ([...modes].some((m) => m !== 'tools')) report.modes = [...modes];
  };
  const ignored = parseOutcomesDetailed(task.outcomes).ignored;
  const outcomeWarnings = ignored.length
    ? [`Lines in the expected outcomes not read as outcomes: ${ignored.map((l) => JSON.stringify(l)).join(', ')}`]
    : [];
  report.warnings = outcomeWarnings;
  if (!refs.some((r) => r.kind === 'success')) {
    return { report: { ...report, reason: 'At least one successful reference snapshot is required.' } };
  }
  if (task.outcomes && canonical(task.outcomes) && parseOutcomes(task.outcomes).length === 0) {
    return {
      report: { ...report, reason: 'Expected outcomes were given, but no outcome clause could be read from them.' },
    };
  }

  // 1. Rubric
  let requirements: Requirement[];
  if (opts.requirements) {
    const errors = checkRubric(task, opts.requirements, parseOutcomes(task.outcomes));
    if (errors.length) return { report: { ...report, reason: `Given requirements are invalid: ${errors.join(' ')}` } };
    requirements = opts.requirements;
  } else if (opts.rubric === 'deterministic') {
    requirements = rubricFromClauses(task);
  } else {
    log(`${task.id}: rubric`);
    const r = await modelRubric(task, model, 6);
    add(r.run);
    report.turns.rubric = r.run.turns;
    if (!r.requirements) return { report: { ...report, reason: `Rubric step ended with ${r.run.status}.` } };
    requirements = r.requirements;
  }

  // 2+3. Discovery agent with validating submission
  log(`${task.id}: discovery (${requirements.length} requirements, ${refs.length} references)`);
  let accepted: Verification | undefined;
  const tools = discoveryTools(task, requirements, refs, (v) => (accepted = v));
  const prompt = [
    `Task id: ${task.id}`,
    `Instruction:\n<instruction>\n${task.instruction}\n</instruction>`,
    task.outcomes ? `Expected outcomes:\n<outcomes>\n${task.outcomes}\n</outcomes>` : '',
    `Requirements (each check must name one; a requirement means exactly what its quote says, the summary is only a label):\n${requirements.map((r) => `- ${r.id} [${r.kind}] ${JSON.stringify(r.source.quote)} (summary: ${r.text})`).join('\n')}`,
    `Reference snapshots:\n${refs.map((r) => `- ${r.name} (${r.kind === 'success' ? 'correct run' : 'incorrect run'}${r.note ? `, ${r.note}` : ''}): ${summary(r.snapshot)}`).join('\n')}`,
    opts.trajectory
      ? `Agent trajectory of the first correct run. Context only — it tells you where to look; it is never evidence and checks must not rely on it:\n<trajectory>\n${opts.trajectory}\n</trajectory>`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const run = await runAgent<CheckSet>({
    model,
    system: discoverySystem(refs),
    prompt,
    tools,
    maxTurns: opts.maxTurns ?? 40,
    nudge: DISCOVERY_NUDGE,
  });
  add(run);
  report.turns.discovery = run.turns;
  if (!run.result || !accepted) return { report: { ...report, reason: `Discovery ended with ${run.status}.` } };

  const checkSet: CheckSet = {
    ...run.result,
    compiled: {
      compiler: ASSAY_VERSION,
      model: opts.provenance?.model ?? model.id,
      modelsUsed: [...models],
      at: opts.provenance?.at ?? new Date().toISOString(),
    },
  };
  return {
    checkSet,
    report: {
      ...report,
      status: 'compiled',
      coverage: coverage(checkSet),
      warnings: [...outcomeWarnings, ...(accepted as Verification).warnings],
      references: (accepted as Verification).references,
    },
  };
}
