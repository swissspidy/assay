/**
 * The mining-first compiler (ADR 0020): candidate generation, the rule that a candidate never
 * compares evidence with a value its quote does not name, ranking, mine-only success and
 * failure, and mine-first with a scripted model (seeding, open requirements, the same gate).
 */
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { call, lastResults, scripted } from '../support/scripted.ts';
import {
  CHECKS_SCHEMA,
  validateCheckSet,
  type Assertion,
  type CheckSet,
  type EvidenceSnapshot,
  type Json,
  type Requirement,
} from '../../src/index.ts';
import {
  compileTask,
  generateCandidates,
  mineCandidates,
  Quote,
  rankCandidates,
  rubricFromClauses,
  type CandidateResult,
  type Reference,
  type TaskInput,
} from '../../src/compiler/index.ts';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../../src/config/config.ts';
import { run as runCli } from '../../src/cli/main.ts';
import { APPS } from '../../examples/apps.ts';
import { compileReference } from '../../examples/lib/scenario.ts';

const run = (app: string, task: string, name: string): EvidenceSnapshot =>
  JSON.parse(readFileSync(new URL(`../../examples/${app}/references/${task}/${name}.json`, import.meta.url), 'utf8'))
    .snapshot;

const handwritten = (app: string, task: string): CheckSet =>
  JSON.parse(readFileSync(new URL(`../../examples/${app}/tasks/${task}.checks.json`, import.meta.url), 'utf8'));

const taskOf = (app: string, task: string): TaskInput => {
  const h = handwritten(app, task);
  return {
    id: `${app}/${task}`,
    instruction: h.task.instruction,
    ...(h.task.outcomes ? { outcomes: h.task.outcomes } : {}),
  };
};

const req = (id: string, quote: string): Requirement => ({
  id,
  kind: 'hard',
  text: quote,
  source: { field: 'outcomes', quote },
});

/** A minimal snapshot: a page, its tree and the probes given. */
const snap = (probes: Record<string, Json>, extra: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '2026-11-06T00:00:00.000Z',
  page: { url: 'http://shop.test/orders/A1', title: 'Order' },
  a11y: {
    role: 'document',
    children: [{ role: 'main', children: [{ role: 'heading', name: 'Order confirmed', level: 1 }] }],
  },
  text: 'Order confirmed',
  network: [],
  storage: { cookies: [], local: {}, session: {} },
  probes: Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, { ok: true, value: v }])),
  meta: { capturer: 'test', redacted: [] },
  ...extra,
});

// ---------------------------------------------------------------------------
// The no-unstated-conditions rule, checked independently of the miner
// ---------------------------------------------------------------------------

const words = (s: string): string[] =>
  s
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Same word, or an inflection: one is the other plus a suffix, sharing at least four letters (or a plural s). */
const inflects = (a: string, b: string) => {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l === `${s}s` && s.length >= 3) return true;
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return i >= 4 && s.length - i <= 3 && l.length - i <= 5;
};

/** Whether the quote states this literal: each of its words in the quote, a number it spells, or a date it spells. */
function quoteStates(quote: string, v: Json): boolean {
  const qw = words(quote);
  if (typeof v === 'number')
    return qw.includes(String(v)) || qw.includes(NUMBER_WORDS[v] ?? '') || quote.includes(String(v));
  if (typeof v !== 'string') return true; // booleans: the field name must be quoted (checked by the miner's tests below)
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v);
  if (iso) {
    const month = MONTHS[Number(iso[2]) - 1]!;
    const ok = qw.includes(month) && qw.includes(String(Number(iso[3]))) && qw.includes(iso[1]!);
    return ok && (!iso[4] || quote.includes(`${Number(iso[4])}:${iso[5]}`) || quote.includes(`${iso[4]}:${iso[5]}`));
  }
  const time = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (time) return quote.includes(v);
  return words(v).every((w) => qw.some((q) => inflects(q, w)));
}

/** Every literal an assertion compares evidence with (not where it reads it: probe, pointer, request path). */
function pinnedLiterals(a: Assertion): Json[] {
  const out: Json[] = [];
  const schema = (s: unknown): void => {
    if (Array.isArray(s)) return s.forEach(schema);
    if (!s || typeof s !== 'object') return;
    for (const [k, v] of Object.entries(s)) {
      if (k === 'const') out.push(v as Json);
      else if (k === 'enum') out.push(...(v as Json[]));
      else if (k === 'pattern') out.push((v as string).replace(/\\s\*|\[\.!\]\?|[\\^$]/g, '').trim());
      else schema(v);
    }
  };
  const text = (m: unknown) => {
    if (typeof m === 'string') out.push(m);
    else if (m && typeof m === 'object') {
      const t = m as { equals?: string; contains?: string };
      if (t.equals !== undefined) out.push(t.equals);
      if (t.contains !== undefined) out.push(t.contains);
    }
  };
  switch (a.kind) {
    case 'value':
      if ('equals' in a.expect) out.push(a.expect.equals);
      if ('schema' in a.expect) schema(a.expect.schema);
      break;
    case 'request':
      schema(a.match.requestBody);
      schema(a.match.responseBody);
      break;
    case 'url':
      out.push(...(a.match.path ?? '').split('/').filter((s) => s && s !== '*'));
      break;
    case 'state':
      if ('role' in a.target) text(a.target.name);
      break;
    case 'contains':
      text(a.match.name);
      text(a.match.text);
      break;
    default:
      throw new Error(`unexpected candidate kind ${a.kind}`);
  }
  return out;
}

test.describe('no unstated conditions', () => {
  test('a candidate compares evidence only with values the quote names', () => {
    // The record holds more than the quote says: only "express" may be pinned.
    const refs: Reference[] = [
      {
        name: 'ref',
        kind: 'success',
        snapshot: snap({
          latestOrder: { id: 'A1', status: 'placed', shipping: 'express', name: 'Ada', giftWrap: false },
        }),
      },
    ];
    const cands = generateCandidates([req('R1', 'the order ships express')], refs);
    expect(cands.length).toBeGreaterThan(0);
    const pinned = cands.flatMap((c) => pinnedLiterals(c.assert));
    expect(pinned).toContain('express');
    for (const v of ['placed', 'Ada', 'A1', false]) expect(pinned).not.toContain(v);
    expect(cands.find((c) => c.family === 'probe')!.assert).toEqual({
      kind: 'value',
      source: { from: 'probe', probe: 'latestOrder', pointer: '/shipping' },
      expect: { equals: 'express' },
    });
  });

  test('no candidate pins a value from a quote that names none', () => {
    const refs: Reference[] = [
      { name: 'ref', kind: 'success', snapshot: snap({ settings: { theme: 'dark', lang: 'de' } }) },
    ];
    const cands = generateCandidates([req('R1', 'the preferences are saved')], refs);
    expect(cands.flatMap((c) => pinnedLiterals(c.assert))).toEqual([]);
  });

  test('identifiers are pinned only as #n, booleans only under a quoted field name', () => {
    const issues = [
      { id: 1, title: 'Crash', state: 'closed', comments: 1, locked: true },
      { id: 2, title: 'Typo', state: 'open', comments: 0, locked: false },
    ];
    const refs: Reference[] = [{ name: 'ref', kind: 'success', snapshot: snap({ issues }) }];
    const c = generateCandidates([req('R1', 'issue #1 is closed')], refs).find((x) => x.family === 'probe');
    expect(c!.assert).toEqual({
      kind: 'value',
      source: { from: 'probe', probe: 'issues' },
      expect: {
        schema: {
          type: 'array',
          contains: {
            type: 'object',
            required: ['id', 'state'],
            properties: { id: { const: 1 }, state: { const: 'closed' } },
          },
        },
      },
    });
    // "1 comment" is not stated by "#1"; `locked` is not a quoted field name.
    expect(JSON.stringify(c!.assert)).not.toContain('comments');
    expect(JSON.stringify(c!.assert)).not.toContain('locked');
  });

  test('every candidate on every example task pins only what its quote states', () => {
    let checked = 0;
    for (const app of APPS) {
      for (const def of app.tasks) {
        const task = taskOf(app.name, def.id);
        const ref = compileReference(def).name;
        const refs: Reference[] = [{ name: ref, kind: 'success', snapshot: run(app.name, def.id, ref) }];
        const compiled = JSON.parse(
          readFileSync(new URL(`compiled/${def.id}.checks.json`, app.dir), 'utf8'),
        ) as CheckSet;
        for (const reqs of [rubricFromClauses(task), compiled.requirements]) {
          for (const c of generateCandidates(reqs, refs)) {
            const quote = reqs.find((r) => r.id === c.requirement)!.source.quote;
            for (const v of pinnedLiterals(c.assert)) {
              checked++;
              expect(
                quoteStates(quote, v),
                `${task.id} ${c.id} pins ${JSON.stringify(v)} for ${JSON.stringify(quote)}`,
              ).toBe(true);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Quotes, candidates and ranking
// ---------------------------------------------------------------------------

test('a quote names words, inflections, numbers, identifiers and dates', () => {
  const q = new Quote('Then issue #3 is closed on November 5, 2026 at 12:30 with two Blue Mugs');
  expect(q.namesString('closed')).toBe(true);
  expect(q.namesString('Blue Mug')).toBe(true);
  expect(q.namesString('Red Mug')).toBe(false);
  expect(q.namesString('the')).toBe(false);
  expect(q.namesDate('2026-11-05')).toBe(true);
  expect(q.namesDate('2026-11-05T12:30:00')).toBe(true);
  expect(q.namesDate('2026-11-05T13:30:00')).toBe(false);
  expect(q.namesNumber(2, false)).toBe(true);
  expect(q.namesNumber(3, true)).toBe(true);
  // #3 is an identifier, not a quantity; the date's day and year are not quantities either.
  expect(q.namesNumber(3, false)).toBe(false);
  expect(q.namesNumber(5, false)).toBe(false);
  expect(new Quote('Then the cart no longer contains a Red Mug').quantified).toBe(true);
  expect(new Quote('Add the tag "testing"').adds).toBe(true);
});

test('candidates come from every evidence family, in the trust order', () => {
  const refs: Reference[] = [
    { name: 'ref', kind: 'success', snapshot: run('tiny-shop', '07-express-order', 'express-order') },
  ];
  const cands = generateCandidates(
    [req('R1', 'the order confirmation is shown'), req('R2', 'the order ships express')],
    refs,
  );
  const families = new Set(cands.map((c) => c.family));
  for (const f of ['probe', 'network', 'url', 'a11y'] as const) expect(families).toContain(f);
  const r1 = cands.filter((c) => c.requirement === 'R1');
  expect(r1.map((c) => c.assert)).toContainEqual({ kind: 'url', match: { path: '/orders/*' } });
  // The heading's whole name is the quote's words, inflected: "order confirmation" → "Order confirmed".
  expect(r1.map((c) => c.assert)).toContainEqual({
    kind: 'contains',
    match: { role: 'heading', name: { equals: 'Order confirmed', ignoreCase: true } },
  });
  expect(r1.find((c) => c.family === 'a11y')!.stated).toBe(false);
});

test('ranking: discrimination first, then trust, then simplicity', () => {
  const c = (id: string, discrimination: number, family: CandidateResult['family'], size: number) =>
    ({ id, discrimination, family, size }) as CandidateResult;
  const ranked = rankCandidates([
    c('a11y-big', 0, 'a11y', 10),
    c('probe-big', 0, 'probe', 90),
    c('probe-small', 0, 'probe', 30),
    c('url-discriminating', 1, 'url', 50),
    c('network', 0, 'network', 5),
  ]);
  expect(ranked.map((x) => x.id)).toEqual(['url-discriminating', 'probe-small', 'probe-big', 'network', 'a11y-big']);
});

test('mining evaluates every candidate in one batch: references, variants, baseline', () => {
  const task = taskOf('tiny-tracker', '03-close-issue');
  const refs: Reference[] = [
    { name: 'closed-1', kind: 'success', snapshot: run('tiny-tracker', '03-close-issue', 'closed-1') },
    { name: 'spoofed', kind: 'negative', snapshot: run('tiny-tracker', '03-close-issue', 'spoofed-closed') },
  ];
  const m = mineCandidates({ task, requirements: rubricFromClauses(task), refs });
  expect(m.variants).toBeGreaterThan(5);
  const [r] = m.requirements;
  expect(r!.decisive.length).toBeGreaterThan(0);
  const best = r!.decisive[0]!;
  expect(best.family).toBe('probe');
  expect(best.negativesRejected).toEqual(['spoofed']);
  // Ranked: every decisive candidate rejects at least as many runs as the next.
  for (let i = 1; i < r!.decisive.length; i++)
    expect(r!.decisive[i - 1]!.discrimination).toBeGreaterThanOrEqual(r!.decisive[i]!.discrimination);
});

test('a candidate that fails on a correct reference or a valid variant does not survive', () => {
  // Two correct references with different totals: a total pinned from one fails on the other.
  const a = snap({ cart: { items: [{ name: 'Blue Mug', qty: 3 }], total: 30 } });
  const b = snap({ cart: { items: [{ name: 'Blue Mug', qty: 3 }], total: 33 } });
  const m = mineCandidates({
    task: { id: 't', instruction: 'Set it.', outcomes: 'Then the cart shows 3 Blue Mugs' },
    requirements: [req('R1', 'the cart shows 3 Blue Mugs')],
    refs: [
      { name: 'a', kind: 'success', snapshot: a },
      { name: 'b', kind: 'success', snapshot: b },
    ],
  });
  for (const c of m.candidates) expect(JSON.stringify(c.assert)).not.toContain('"total"');
  // The same value and record in both: survives, but "shows" needs page evidence, so it does not settle the requirement.
  const probe = m.candidates.find((c) => c.family === 'probe')!;
  expect(probe.survives).toBe(true);
  expect(probe.unexplained).toEqual(['shows']);
  expect(probe.decisive).toBe(false);
});

// ---------------------------------------------------------------------------
// compileTask: mine-only and mine-first
// ---------------------------------------------------------------------------

test('mine-only with the deterministic rubric compiles without any model', async () => {
  const task = taskOf('tiny-tracker', '03-close-issue');
  const refs: Reference[] = [
    { name: 'closed-1', kind: 'success', snapshot: run('tiny-tracker', '03-close-issue', 'closed-1') },
  ];
  const { checkSet, report } = await compileTask(task, refs, { discovery: 'mine-only', rubric: 'deterministic' });
  expect(report.status).toBe('compiled');
  expect(report.model).toBe('none');
  expect(report.turns).toEqual({ rubric: 0, discovery: 0 });
  expect(report.usage.inputTokens).toBe(0);
  expect(report.mining).toMatchObject({ strategy: 'mine-only', discovery: 'mined' });
  expect(report.mining!.requirements).toEqual([expect.objectContaining({ status: 'covered', check: 'R1-mined-1' })]);
  expect(checkSet!.compiled).toMatchObject({ model: 'none', modelsUsed: [], discovery: 'mined' });
  expect(validateCheckSet(checkSet!).ok).toBe(true);
  // Held out: the other correct run passes, the wrong issue and the spoofed page do not.
  const { evaluate } = await import('../../src/index.ts');
  expect(evaluate(checkSet!, run('tiny-tracker', '03-close-issue', 'closed-2')).verdict).toBe('fail');
  expect(evaluate(checkSet!, run('tiny-tracker', '03-close-issue', 'spoofed-closed')).verdict).not.toBe('success');
  expect(evaluate(checkSet!, run('tiny-tracker', '03-close-issue', 'commented-and-closed')).verdict).toBe('success');
});

test('mine-only fails with a reason per requirement it cannot cover', async () => {
  const task = taskOf('tiny-shop', '04-remove-red-mug');
  const name = readdirSync(
    new URL('../../examples/tiny-shop/references/04-remove-red-mug/', import.meta.url),
  )[0]!.replace(/\.json$/, '');
  const refs: Reference[] = [{ name, kind: 'success', snapshot: run('tiny-shop', '04-remove-red-mug', name) }];
  const { checkSet, report } = await compileTask(task, refs, { discovery: 'mine-only', rubric: 'deterministic' });
  expect(checkSet).toBeUndefined();
  expect(report.status).toBe('failed');
  expect(report.reason).toContain('Mining did not cover every requirement:');
  expect(report.reason).toContain('R1 "the cart no longer contains a Red Mug": ');
  expect(report.reason).toContain('R2 "the other items stay in the cart": ');
  expect(report.reason).toContain('no longer');
  expect(report.mining!.requirements.every((r) => r.status === 'open' && r.reason)).toBe(true);
});

test('mine-only never weakens the gate: an incorrect run nothing mined rejects fails the compile', async () => {
  const task = taskOf('tiny-tracker', '03-close-issue');
  const s = run('tiny-tracker', '03-close-issue', 'closed-1');
  const refs: Reference[] = [
    { name: 'closed-1', kind: 'success', snapshot: s },
    // The same evidence labelled incorrect: no check can pass the one and reject the other.
    { name: 'mislabelled', kind: 'negative', snapshot: structuredClone(s) },
  ];
  const { checkSet, report } = await compileTask(task, refs, { discovery: 'mine-only', rubric: 'deterministic' });
  expect(checkSet).toBeUndefined();
  expect(report.reason).toContain('Mining did not cover every requirement');
});

test('mine-first: covered by mining, the model writes the rubric and no discovery turn runs', async () => {
  const task = taskOf('tiny-tracker', '03-close-issue');
  const refs: Reference[] = [
    { name: 'closed-1', kind: 'success', snapshot: run('tiny-tracker', '03-close-issue', 'closed-1') },
  ];
  const model = scripted([
    () =>
      call('submit_rubric', {
        requirements: [
          { id: 'R1', kind: 'hard', text: 'Issue 1 closed', field: 'outcomes', quote: 'issue #1 is closed' },
        ],
      }),
  ]);
  const { checkSet, report } = await compileTask(task, refs, { model, discovery: 'mine-first' });
  expect(report.status).toBe('compiled');
  expect(report.turns).toEqual({ rubric: 1, discovery: 0 });
  expect(model.requests).toHaveLength(1);
  expect(report.mining!.discovery).toBe('mined');
  expect(checkSet!.compiled).toMatchObject({
    model: 'scripted:test',
    modelsUsed: ['scripted:test'],
    discovery: 'mined',
  });
});

test('mine-first: the agent gets only the open requirements, seeded with what mining found', async () => {
  const task = taskOf('tiny-shop', '07-express-order');
  const refs: Reference[] = [
    { name: 'express-order', kind: 'success', snapshot: run('tiny-shop', '07-express-order', 'express-order') },
  ];
  const requirements = rubricFromClauses(task);
  const own = {
    id: 'C-confirmation',
    requirement: 'R3',
    description: 'The confirmation heading is shown.',
    assert: { kind: 'contains', match: { role: 'heading', name: { contains: 'Order confirmed', ignoreCase: true } } },
  };
  const model = scripted([
    (r) => {
      const prompt = r.messages[0]!.text ?? JSON.stringify(r.messages[0]);
      expect(prompt).toContain('Open requirements');
      expect(prompt).toContain('- R3 [hard] "the order confirmation is shown"');
      expect(prompt).not.toContain('- R1 [hard]');
      expect(prompt).toContain('Requirements already covered by mined checks');
      expect(prompt).toContain('R1-mined-1');
      expect(prompt).toContain('Mined candidates for the open requirements');
      expect(r.tools.map((t) => t.name)).toContain('mined_candidates');
      return call('mined_candidates', { requirement: 'R3' });
    },
    (r) => {
      const seeds = JSON.parse(lastResults(r)[0]!.content) as { requirement: string }[];
      expect(seeds.length).toBeGreaterThan(0);
      expect(seeds.every((s) => s.requirement === 'R3')).toBe(true);
      return call('submit_checks', { checks: [own] });
    },
  ]);
  const { checkSet, report } = await compileTask(task, refs, { model, requirements, discovery: 'mine-first' });
  expect(report.status).toBe('compiled');
  expect(report.turns.discovery).toBe(2);
  expect(report.mining!.discovery).toBe('mined+model');
  expect(report.mining!.requirements.map((r) => r.status)).toEqual(['covered', 'covered', 'open']);
  expect(checkSet!.checks.map((c) => c.requirement)).toEqual(['R1', 'R2', 'R3']);
  expect(checkSet!.checks.at(-1)!.id).toBe('C-confirmation');
  expect(checkSet!.compiled!.discovery).toBe('mined+model');
});

test('mine-first: the merged submission passes the same gate (a failing agent check is refused)', async () => {
  const task = taskOf('tiny-shop', '07-express-order');
  const refs: Reference[] = [
    { name: 'express-order', kind: 'success', snapshot: run('tiny-shop', '07-express-order', 'express-order') },
  ];
  const wrong = {
    id: 'C-wrong',
    requirement: 'R3',
    description: 'A heading that is not there.',
    assert: { kind: 'contains', match: { role: 'heading', name: 'Payment failed' } },
  };
  const model = scripted([
    () => call('submit_checks', { checks: [wrong] }),
    (r) => {
      expect(lastResults(r)[0]!.isError).toBe(true);
      expect(lastResults(r)[0]!.content).toContain('C-wrong fails');
      return { text: 'I give up.' };
    },
    () => ({ text: 'Still nothing.' }),
    () => ({ text: 'Done.' }),
  ]);
  const { checkSet, report } = await compileTask(task, refs, {
    model,
    requirements: rubricFromClauses(task),
    discovery: 'mine-first',
    maxTurns: 4,
  });
  expect(checkSet).toBeUndefined();
  expect(report.mining!.discovery).toBe('none');
});

test('the default strategy is the model: no mining, no mined_candidates tool', async () => {
  const task = taskOf('tiny-tracker', '03-close-issue');
  const refs: Reference[] = [
    { name: 'closed-1', kind: 'success', snapshot: run('tiny-tracker', '03-close-issue', 'closed-1') },
  ];
  const model = scripted([
    (r) => {
      expect(r.tools.map((t) => t.name)).not.toContain('mined_candidates');
      return { text: 'no' };
    },
    () => ({ text: 'no' }),
    () => ({ text: 'no' }),
  ]);
  const { report } = await compileTask(task, refs, { model, rubric: 'deterministic', maxTurns: 3 });
  expect(report.mining).toBeUndefined();
});

test('config: compile.discovery is validated and used when a config is passed', async () => {
  expect(() => normalizeConfig({ compile: { discovery: 'mine-sometimes' } }, '/')).toThrow(
    '`compile.discovery` must be "model", "mine-first" or "mine-only"',
  );
  expect(() => normalizeConfig({ compile: { mine: true } }, '/')).toThrow('unknown option `compile.mine`');
  const task = taskOf('tiny-tracker', '03-close-issue');
  const refs: Reference[] = [
    { name: 'closed-1', kind: 'success', snapshot: run('tiny-tracker', '03-close-issue', 'closed-1') },
  ];
  const { report } = await compileTask(task, refs, {
    rubric: 'deterministic',
    config: { compile: { discovery: 'mine-only' } },
  });
  expect(report.status).toBe('compiled');
  expect(report.mining!.strategy).toBe('mine-only');
});

test.describe('assay compile', () => {
  const ref = fileURLToPath(
    new URL('../../examples/tiny-tracker/references/03-close-issue/closed-1.json', import.meta.url),
  );
  const cli = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      color: false,
      errColor: false,
      env: {},
    });
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  };

  test('--mine-only --rubric deterministic needs no model', async () => {
    const r = await cli([
      'compile',
      'Close issue #1.',
      '--outcomes',
      'Then issue #1 is closed',
      '-r',
      ref,
      '--mine-only',
      '--rubric',
      'deterministic',
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('✔ Compiled task by mining alone (no model)');
    expect(r.stderr).toContain('Mining: 1/1 requirements covered');
    expect(JSON.parse(r.stdout).compiled).toMatchObject({ model: 'none', discovery: 'mined' });
  });

  test('--mine-only reports each requirement it cannot cover and exits 1', async () => {
    const r = await cli([
      'compile',
      'Close issue #1.',
      '--outcomes',
      'Then only issue #1 is closed',
      '-r',
      ref,
      '--mine-only',
      '--rubric',
      'deterministic',
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Mining did not cover every requirement:');
    expect(r.stderr).toContain('R1 "only issue #1 is closed": ');
  });

  test('--mine-first and --mine-only exclude each other; --mine-first still needs a model', async () => {
    expect((await cli(['compile', 'Do it.', '-r', ref, '--mine-first', '--mine-only'])).code).toBe(3);
    expect((await cli(['compile', 'Do it.', '-r', ref, '--mine-first'])).stderr).toContain(
      'assay compile needs a model',
    );
  });
});

test('the compiled provenance accepts discovery, and nothing else new', () => {
  const cs: CheckSet = {
    schema: CHECKS_SCHEMA,
    id: 't',
    version: '1',
    task: { instruction: 'Close issue #1.' },
    requirements: [req('R1', 'Close issue #1.')].map((r) => ({
      ...r,
      source: { field: 'instruction', quote: 'Close issue #1.' },
    })),
    checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert: { kind: 'url', match: { path: '/issues/1' } } }],
    compiled: { compiler: 'assay/x', model: 'none', modelsUsed: [], at: 'now', discovery: 'mined' },
  };
  expect(validateCheckSet(cs).ok).toBe(true);
  expect(validateCheckSet({ ...cs, compiled: { ...cs.compiled!, discovery: 'guessed' as 'mined' } }).ok).toBe(false);
});
