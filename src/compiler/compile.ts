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
import type { Assertion, Check, CheckSet, EvidenceSnapshot, Requirement, Channel, Trust } from '../types.ts';
import { CHECKS_SCHEMA, CHANNEL_TRUST } from '../types.ts';
import { checkSetSchema } from '../dsl/schema.ts';
import { validateCheckSet } from '../dsl/validate.ts';
import { evaluate, evaluateAssertion } from '../runtime/evaluate.ts';
import { AXIndex } from '../runtime/axindex.ts';
import { canonical } from '../text.ts';
import { runAgent, type AgentTool, type AgentRun } from '../model/agent.ts';
import type { ModelClient } from '../model/types.ts';
import { parseOutcomes, parseOutcomesDetailed, type Clause } from './outcomes.ts';
import { findNodes, networkEntry, networkLog, outline, probesView, storageView, summary } from './explore.ts';
import { DISCOVERY_NUDGE, DISCOVERY_SYSTEM, RUBRIC_SYSTEM } from './prompts.ts';

export interface TaskInput {
  id: string;
  instruction: string;
  /** Expected outcomes: Gherkin "Then" clauses, a Markdown list, or plain lines. */
  outcomes?: string;
}

export interface Reference {
  name: string;
  /** "success": a correct run (checks must succeed). "negative": an incorrect run (checks must not succeed). */
  kind: 'success' | 'negative';
  snapshot: EvidenceSnapshot;
}

export interface CompileOptions {
  model: ModelClient;
  /** "model" (default) asks the model for the rubric; "deterministic" makes one hard requirement per outcome clause. */
  rubric?: 'model' | 'deterministic';
  /**
   * Optional agent trajectory (actions, notes). Context only: it helps the
   * agent know where to look, it is never evidence.
   */
  trajectory?: string;
  maxTurns?: number;
  log?: (msg: string) => void;
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
}

export interface CompileReport {
  task: string;
  status: 'compiled' | 'failed';
  reason?: string;
  model: string;
  modelsUsed: string[];
  turns: { rubric: number; discovery: number };
  usage: { inputTokens: number; outputTokens: number };
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
/** The optional wording opens or closes a soft quote, so it qualifies the whole quote. */
const OPTIONAL_EDGE =
  /^(?:(?:then|and|but)\s+)?(?:optional(?:ly)?|if possible|ideally|nice to have|if you can|bonus)\b|\b(?:optional(?:ly)?|if possible|ideally|nice to have|if you can|bonus)[.!]?$/i;
const WORD = /[\p{L}\p{N}]/u;

/** Whether `quote` contains the whole clause. */
export function containsClause(quote: string, clause: string): boolean {
  const q = fold(quote);
  return q.length > 0 && q.includes(fold(clause));
}

/** Whether `quote` is a part of the clause (possibly all of it). */
export function partOfClause(quote: string, clause: string): boolean {
  const q = fold(quote);
  return q.length > 0 && fold(clause).includes(q);
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
    if (r.kind === 'soft' && !OPTIONAL.test(r.source.quote)) {
      errors.push(
        `${r.id}: ${JSON.stringify(r.source.quote)} is marked soft, but the quoted words do not say it is optional; make it hard.`,
      );
    } else if (OPTIONAL.test(r.source.quote) && (r.kind === 'hard' || !OPTIONAL_EDGE.test(canonical(r.source.quote)))) {
      // "ships express, ideally with a receipt": the optional word covers only what follows it.
      // As soft, the mandatory part could never fail a run; as hard, the optional part could.
      errors.push(
        r.kind === 'hard' && OPTIONAL_EDGE.test(canonical(r.source.quote))
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

function sourceChannels(a: Assertion): Channel[] {
  switch (a.kind) {
    case 'state':
    case 'contains':
      return ['a11y'];
    case 'url':
      return ['url'];
    case 'request':
      return ['network'];
    case 'value': {
      const f = a.source.from;
      return [f === 'node' ? 'a11y' : f === 'request' || f === 'response' ? 'network' : f === 'text' ? 'text' : f];
    }
    case 'allOf':
    case 'anyOf':
      return [...new Set(a.of.flatMap(sourceChannels))];
  }
}

/**
 * How hard an assertion is to satisfy by faking page content. `anyOf` is as weak
 * as its weakest branch (that branch alone can pass); `allOf` as strong as its
 * strongest part (every part must pass).
 */
export function assertionTrust(a: Assertion): number {
  switch (a.kind) {
    case 'anyOf':
      return Math.min(...a.of.map(assertionTrust));
    case 'allOf':
      return Math.max(...a.of.map(assertionTrust));
    default:
      return TRUST_RANK[CHANNEL_TRUST[sourceChannels(a)[0]!]];
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
    };
  });
}

interface Verification {
  errors: string[];
  warnings: string[];
  references: CompileReport['references'];
}

/** Validate a candidate check set and run it against every reference. */
export function verifyCandidate(cs: CheckSet, refs: Reference[]): Verification {
  const v = validateCheckSet(cs);
  const errors = [...v.errors];
  const warnings = [...v.warnings];
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
  for (const cov of coverage(cs)) {
    if (cov.trust === 'freetext')
      warnings.push(`Requirement ${cov.requirement} is covered only by free page text, which a page can spoof.`);
  }
  return { errors, warnings, references };
}

const CHECKS_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: { checks: { type: 'array', minItems: 1, items: { $ref: '#/definitions/check' } } },
  definitions: checkSetSchema.definitions,
};

const ASSERT_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assert'],
  properties: { assert: { $ref: '#/definitions/assertion' } },
  definitions: checkSetSchema.definitions,
};

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
  const pickRef = (name: string | undefined): Reference => refs.find((r) => r.name === name) ?? refs[0]!;
  const refProp = {
    reference: { type: 'string', enum: refNames, description: 'Reference snapshot name (default: the first one).' },
  };
  type In<T> = T & { reference?: string };

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
        inputSchema: ASSERT_TOOL_SCHEMA,
      },
      run(i: { assert: Assertion }) {
        const lines = refs.map((r) => {
          const res = evaluateAssertion({ snapshot: r.snapshot, index: new AXIndex(r.snapshot.a11y) }, i.assert);
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
        inputSchema: CHECKS_TOOL_SCHEMA,
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
        const v = verifyCandidate(cs, refs);
        if (v.errors.length) {
          return {
            content: `Not accepted. Fix these and resubmit all checks:\n- ${v.errors.join('\n- ')}${v.warnings.length ? `\nWarnings:\n- ${v.warnings.join('\n- ')}` : ''}`,
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

export async function compileTask(task: TaskInput, refs: Reference[], opts: CompileOptions): Promise<CompileResult> {
  // Tools select references by name (an enum in their schemas), so names must be unique.
  const seen = new Set<string>();
  for (const r of refs) {
    if (seen.has(r.name))
      throw new Error(`Duplicate reference name ${JSON.stringify(r.name)}; reference names must be unique.`);
    seen.add(r.name);
  }
  const log = opts.log ?? (() => {});
  const usage = { inputTokens: 0, outputTokens: 0 };
  const models = new Set<string>();
  const report: CompileReport = {
    task: task.id,
    status: 'failed',
    model: opts.model.id,
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
    run.models.forEach((m) => models.add(m));
    report.modelsUsed = [...models];
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
  if (opts.rubric === 'deterministic') {
    requirements = rubricFromClauses(task);
  } else {
    log(`${task.id}: rubric`);
    const r = await modelRubric(task, opts.model, 6);
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
    `Reference snapshots:\n${refs.map((r) => `- ${r.name} (${r.kind === 'success' ? 'correct run' : 'incorrect run'}): ${summary(r.snapshot)}`).join('\n')}`,
    opts.trajectory
      ? `Agent trajectory of the first correct run. Context only — it tells you where to look; it is never evidence and checks must not rely on it:\n<trajectory>\n${opts.trajectory}\n</trajectory>`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const run = await runAgent<CheckSet>({
    model: opts.model,
    system: DISCOVERY_SYSTEM,
    prompt,
    tools,
    maxTurns: opts.maxTurns ?? 40,
    nudge: DISCOVERY_NUDGE,
  });
  add(run);
  report.turns.discovery = run.turns;
  if (!run.result || !accepted) return { report: { ...report, reason: `Discovery ended with ${run.status}.` } };

  const checkSet = run.result;
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
