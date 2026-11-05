import type {
  AbstainReason,
  Assertion,
  AssertionResult,
  AXNode,
  PageMatch,
  PageView,
  CheckResult,
  Comparison,
  CheckSet,
  Channel,
  EvidenceSnapshot,
  Evidence,
  Json,
  Normalizer,
  Operand,
  Outcome,
  RequirementResult,
  Status,
  Target,
  ValueSource,
} from '../types.ts';
import { CHANNEL_TRUST } from '../types.ts';
import { canonical, describeTextMatch, matchText, stripGlobal } from '../text.ts';
import { checkSetDigest, snapshotDigest } from '../snapshot/digest.ts';
import { AXIndex, describeLocator, readNodeField, resolveTarget, type INode } from './axindex.ts';
import { compare, compareNumber, compareValues, describeNumberCompare, jsonPointer } from './compare.ts';
import { NormalizeError, applyNormalizers, fromJson, toJson, type TypedValue } from './values.ts';
import {
  describePageMatch,
  describeRequestMatch,
  describeUrlMatch,
  matchPage,
  matchRequest,
  matchUrl,
  onUrlRoute,
  truncated,
} from './network.ts';

/** What an assertion is evaluated against. */
export interface EvalCtx {
  snapshot: EvidenceSnapshot;
  index: AXIndex;
  /** Inside an `each` assertion: the record that locators and text sources resolve within. */
  record?: INode;
  /**
   * The check reads route evidence and abstains when it is missing (`onMissing: "abstain"`,
   * ADR 0011): no matching request or a URL elsewhere is `route_missing`, not a failure.
   */
  routeMissing?: boolean;
}

/** Why a check with `onMissing: "abstain"` did not decide. */
const ROUTE_HINT = 'this check reads one way of doing the task, and the run may have done it another way';

const ev = (channel: Channel, extra: Partial<Evidence> = {}): Evidence => ({
  channel,
  trust: CHANNEL_TRUST[channel],
  origin: 'observed',
  ...extra,
});

const pass = (message: string, evidence: Evidence[] = [], drift: string[] = []): AssertionResult => ({
  status: 'pass',
  message,
  evidence,
  drift,
});
const fail = (message: string, evidence: Evidence[] = [], drift: string[] = []): AssertionResult => ({
  status: 'fail',
  message,
  evidence,
  drift,
});
const abstain = (
  reason: AbstainReason,
  message: string,
  evidence: Evidence[] = [],
  drift: string[] = [],
): AssertionResult => ({
  status: 'abstain',
  reason,
  message,
  evidence,
  drift,
});

/** Strong Kleene conjunction. */
export function kleeneAnd(statuses: Status[]): Status {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.every((s) => s === 'pass')) return 'pass';
  return 'abstain';
}

/** Strong Kleene disjunction. */
export function kleeneOr(statuses: Status[]): Status {
  if (statuses.includes('pass')) return 'pass';
  if (statuses.length > 0 && statuses.every((s) => s === 'fail')) return 'fail';
  return 'abstain';
}

function resolve(ctx: EvalCtx, target: Target): { node: INode; drift: string[] } | AssertionResult {
  const r = resolveTarget(ctx.index, target, ctx.record);
  if (!r.ok) return abstain(r.reason, r.message, [], r.drift);
  return { node: r.node, drift: r.drift };
}

const isResult = (x: unknown): x is AssertionResult => !!x && typeof x === 'object' && 'status' in x;

// ---------------------------------------------------------------------------
// Value sources
// ---------------------------------------------------------------------------

/**
 * `absent` marks an observed absence: the channel was captured and the key is not
 * there (storage only). Unlike an unreadable value, this is outcome evidence.
 */
type Read =
  | { value: TypedValue; evidence: Evidence; drift: string[]; absent?: boolean; seq?: number }
  | AssertionResult;

/**
 * A result together with the latest request it read (`seq` in the network log), so that an
 * `anyOf` over routes can let the route taken last decide (ADR 0011). Internal: `evaluate`
 * drops it from the check results.
 */
type Seq = AssertionResult & { seq?: number };
const withSeq = (r: AssertionResult, seq: number | undefined): Seq => (seq === undefined ? r : { ...r, seq });
const latest = (...xs: (number | undefined)[]) => {
  const ns = xs.filter((x): x is number => x !== undefined);
  return ns.length ? Math.max(...ns) : undefined;
};
const ABSENT: TypedValue = { type: 'json', value: null };

function readSource(ctx: EvalCtx, src: ValueSource): Read {
  const snap = ctx.snapshot;
  switch (src.from) {
    case 'node': {
      const r = resolve(ctx, src.target);
      if (isResult(r)) return r;
      const raw = readNodeField(ctx.index, r.node, src.field);
      const locator = ctx.index.path(r.node);
      if (raw === undefined)
        return abstain('value_unavailable', `${locator} has no ${src.field}`, [ev('a11y', { locator })], r.drift);
      return { value: { type: 'string', value: raw }, evidence: ev('a11y', { locator, value: raw }), drift: r.drift };
    }
    case 'text': {
      let text = snap.text;
      let drift: string[] = [];
      let locator = 'document text';
      let channel: Channel = 'text';
      // Inside a record, an unscoped text source reads the record's text, not the page's.
      const scoped = src.scope !== undefined || ctx.record !== undefined;
      if (scoped) {
        let node = ctx.record!;
        if (src.scope) {
          const r = resolve(ctx, src.scope);
          if (isResult(r)) return r;
          node = r.node;
          drift = r.drift;
        }
        // Scoped text is derived from accessible names, so it is canonicalized like a node's text.
        text = canonical(ctx.index.text(node));
        locator = `text of ${ctx.index.path(node)}`;
        channel = 'a11y';
      }
      const m = new RegExp(src.pattern, stripGlobal(src.flags)).exec(scoped ? text : text.replace(/[^\S\n]+/g, ' '));
      if (!m)
        return abstain(
          'value_unavailable',
          `/${src.pattern}/ not found in ${locator}`,
          [ev(channel, { locator })],
          drift,
        );
      const g = src.group ?? (m.length > 1 ? 1 : 0);
      const v = typeof g === 'number' ? m[g] : m.groups?.[g];
      if (v === undefined)
        return abstain(
          'value_unavailable',
          `group ${g} of /${src.pattern}/ did not match`,
          [ev(channel, { locator })],
          drift,
        );
      // Free page text is the weakest channel even when scoped by an a11y anchor.
      return { value: { type: 'string', value: v }, evidence: ev('text', { locator, value: v }), drift };
    }
    case 'url': {
      let u: URL;
      try {
        u = new URL(snap.page.url);
      } catch {
        return abstain('value_unavailable', `page URL is not parseable: ${snap.page.url}`);
      }
      let v: string | null;
      if (typeof src.part === 'object') v = u.searchParams.get(src.part.param);
      else v = u[src.part];
      const what = typeof src.part === 'object' ? `query parameter ${src.part.param}` : `URL ${src.part}`;
      if (v === null) return abstain('value_unavailable', `${what} is absent`, [ev('url', { value: snap.page.url })]);
      return { value: { type: 'string', value: v }, evidence: ev('url', { locator: what, value: v }), drift: [] };
    }
    case 'request':
    case 'response': {
      if (!snap.network) return abstain('evidence_unavailable', 'network log was not recorded');
      const results = snap.network.map((e) => [e, matchRequest(src.match, e)] as const);
      const hits = results.filter(([, r]) => r === 'yes').map(([e]) => e);
      const unknown = results.filter(([, r]) => r === 'unknown').length;
      const desc = describeRequestMatch(src.match);
      if (unknown > 0)
        return abstain('value_unavailable', `${unknown} candidate request(s) for ${desc} could not be fully read`, [
          ev('network'),
        ]);
      if (hits.length === 0)
        return ctx.routeMissing
          ? abstain('route_missing', `no request matches ${desc}; ${ROUTE_HINT}`, [ev('network')])
          : abstain('value_unavailable', `no request matches ${desc}`, [ev('network')]);
      const pick = src.pick ?? 'only';
      if (pick === 'only' && hits.length > 1)
        return abstain('value_ambiguous', `${hits.length} requests match ${desc}; use pick "first" or "last"`, [
          ev('network'),
        ]);
      const e = pick === 'last' ? hits[hits.length - 1]! : hits[0]!;
      const body = src.from === 'request' ? e.requestBody : e.responseBody;
      const locator = `${src.from} body of #${e.seq} ${e.method} ${e.url}${src.pointer ? ' at ' + src.pointer : ''}`;
      if (body === undefined || truncated(e, src.from))
        return abstain('value_unavailable', `${src.from} body of #${e.seq} was not captured`, [
          ev('network', { locator }),
        ]);
      const v = jsonPointer(body, src.pointer);
      if (v === undefined)
        return abstain('value_unavailable', `${src.pointer} not present in ${src.from} body of #${e.seq}`, [
          ev('network', { locator }),
        ]);
      return { value: fromJson(v), evidence: ev('network', { locator, value: v }), drift: [], seq: e.seq };
    }
    case 'storage': {
      const before = src.at === 'before';
      if (before && !snap.baseline) return abstain('evidence_unavailable', 'no baseline was captured before the task');
      const storage = before ? snap.baseline!.storage : snap.storage;
      if (!storage)
        return abstain('evidence_unavailable', `storage was not captured${before ? ' before the task' : ''}`);
      const when = before ? ' (before)' : '';
      const pageOrigin = safeOrigin(snap.page.url);
      if (src.area === 'cookie') {
        const host = safeHost(src.origin ?? snap.page.url);
        const c = storage.cookies.filter(
          (cookie) => cookie.name === src.key && (!host || domainMatches(host, cookie.domain)),
        );
        if (c.length === 0)
          return {
            value: ABSENT,
            evidence: ev('storage', { locator: `cookie ${src.key}${when}`, value: null }),
            drift: [],
            absent: true,
          };
        if (c.length > 1 && new Set(c.map((x) => JSON.stringify(x.value))).size > 1)
          return abstain('value_ambiguous', `cookie ${src.key} has ${c.length} different values`, [
            ev('storage', { locator: `cookie ${src.key}${when}` }),
          ]);
        const value = c[0]!.value;
        if (typeof value !== 'string')
          return abstain('evidence_unavailable', `cookie ${src.key} was redacted at capture time`, [
            ev('storage', { locator: `cookie ${src.key}${when}` }),
          ]);
        return {
          value: { type: 'string', value },
          evidence: ev('storage', { locator: `cookie ${src.key}${when}`, value }),
          drift: [],
        };
      }
      const origin = src.origin ? safeOrigin(src.origin) : pageOrigin;
      const area = storage[src.area][origin ?? ''];
      const locator = `${src.area}Storage[${JSON.stringify(src.key)}] @ ${origin}${when}`;
      if (!area || !Object.prototype.hasOwnProperty.call(area, src.key))
        return { value: ABSENT, evidence: ev('storage', { locator, value: null }), drift: [], absent: true };
      const value = area[src.key]!;
      if (typeof value !== 'string')
        return abstain('evidence_unavailable', `${src.area}Storage ${src.key} was redacted at capture time`, [
          ev('storage', { locator }),
        ]);
      return { value: { type: 'string', value }, evidence: ev('storage', { locator, value }), drift: [] };
    }
    case 'probe': {
      const before = src.at === 'before';
      if (before && !snap.baseline) return abstain('evidence_unavailable', 'no baseline was captured before the task');
      const when = before ? ' before the task' : '';
      const p = (before ? snap.baseline!.probes : snap.probes)[src.probe];
      if (!p) return abstain('evidence_unavailable', `probe ${src.probe} was not run${when}`);
      if (!p.ok)
        return abstain('probe_error', `probe ${src.probe} failed${when}: ${p.error}`, [
          ev('probe', { locator: `${src.probe}${before ? ' (before)' : ''}` }),
        ]);
      const v = jsonPointer(p.value, src.pointer);
      const locator = `probe ${src.probe}${before ? ' (before)' : ''}${src.pointer ? ' at ' + src.pointer : ''}`;
      if (v === undefined)
        return abstain('value_unavailable', `${src.pointer} not present in result of probe ${src.probe}${when}`, [
          ev('probe', { locator }),
        ]);
      return { value: fromJson(v), evidence: ev('probe', { locator, value: v }), drift: [] };
    }
  }
}

function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}
function safeHost(u: string): string | null {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}
function domainMatches(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, '');
  return host === d || host.endsWith('.' + d);
}

/** A read and normalized value; `value` is undefined for an observed absence (normalizers do not run). */
type Normalized = { value?: TypedValue; evidence: Evidence; drift: string[]; seq?: number };

function readNormalized(ctx: EvalCtx, src: ValueSource, steps: Normalizer[] | undefined): Normalized | AssertionResult {
  const read = readSource(ctx, src);
  if (isResult(read)) return read;
  if (read.absent) return { evidence: read.evidence, drift: read.drift };
  const seq = read.seq;
  let v: TypedValue;
  try {
    v = applyNormalizers(read.value, steps);
  } catch (e) {
    if (e instanceof NormalizeError) return abstain(e.reason, e.message, [read.evidence], read.drift);
    throw e;
  }
  const evidence = { ...read.evidence, value: toJson(v) };
  if (steps?.length)
    evidence.locator = `${read.evidence.locator ?? ''} (raw ${JSON.stringify(read.evidence.value)})`.trim();
  return { value: v, evidence, drift: read.drift, ...(seq !== undefined ? { seq } : {}) };
}

/** The value a source gives after `steps`, as JSON; undefined when it cannot be read (or is an observed absence). */
export function readValue(ctx: EvalCtx, src: ValueSource, steps: Normalizer[] | undefined): Json | undefined {
  const r = readNormalized(ctx, src, steps);
  return isResult(r) || !r.value ? undefined : toJson(r.value);
}

/**
 * A `sameAs` binding: the value equals the value read from a second source. Either side
 * unreadable abstains; an observed absence on either side fails (there is nothing to be equal to).
 */
function evaluateBinding(ctx: EvalCtx, left: Normalized, other: Operand): AssertionResult {
  const right = readNormalized(ctx, other.source, other.normalize);
  if (isResult(right)) return bindingResult(left, right);
  return withSeq(bindingResult(left, right), latest(left.seq, right.seq));
}

function bindingResult(left: Normalized, right: Normalized | AssertionResult): AssertionResult {
  if (isResult(right))
    return {
      ...right,
      message: `the value to compare with could not be read: ${right.message}`,
      evidence: [left.evidence, ...right.evidence],
      drift: [...left.drift, ...right.drift],
    };
  const evidence = [left.evidence, right.evidence];
  const drift = [...left.drift, ...right.drift];
  const where = right.evidence.locator ?? right.evidence.channel;
  if (!left.value || !right.value) {
    const unset = [left, right].filter((x) => !x.value).map((x) => `${x.evidence.locator} is not set`);
    return fail(`${unset.join(' and ')}; nothing to compare`, evidence, drift);
  }
  try {
    const c = compareValues(left.value, right.value);
    const msg = `${c.message} (${where})`;
    return c.ok ? pass(msg, evidence, drift) : fail(msg, evidence, drift);
  } catch (e) {
    if (e instanceof NormalizeError) return abstain(e.reason, e.message, evidence, drift);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export function evaluateAssertion(ctx: EvalCtx, a: Assertion): AssertionResult {
  switch (a.kind) {
    case 'state': {
      const r = resolve(ctx, a.target);
      if (isResult(r)) return r;
      const n = r.node.node;
      const locator = ctx.index.path(r.node);
      const problems: string[] = [];
      const observed: Record<string, Json> = {};
      for (const k of ['checked', 'pressed', 'selected', 'expanded', 'disabled'] as const) {
        if (a.expect[k] === undefined) continue;
        const actual = n.states?.[k] ?? false;
        observed[k] = actual;
        if (actual !== a.expect[k])
          problems.push(`${k} is ${JSON.stringify(actual)}, expected ${JSON.stringify(a.expect[k])}`);
      }
      if (a.expect.level !== undefined) {
        observed.level = n.level ?? null;
        if (n.level !== a.expect.level) problems.push(`level is ${n.level ?? 'unset'}, expected ${a.expect.level}`);
      }
      for (const k of ['name', 'value', 'text'] as const) {
        const m = a.expect[k];
        if (m === undefined) continue;
        const actual = k === 'text' ? ctx.index.text(r.node) : n[k];
        observed[k] = actual ?? null;
        if (!matchText(m, actual))
          problems.push(`${k} is ${JSON.stringify(actual ?? null)}, expected ${describeTextMatch(m)}`);
      }
      const evidence = [ev('a11y', { locator, value: observed })];
      return problems.length
        ? fail(`${locator}: ${problems.join('; ')}`, evidence, r.drift)
        : pass(`${locator} has the expected state`, evidence, r.drift);
    }
    case 'contains': {
      let scope = ctx.record ?? ctx.index.root;
      let drift: string[] = [];
      if (a.scope) {
        const r = resolve(ctx, a.scope);
        if (isResult(r)) return r;
        scope = r.node;
        drift = r.drift;
      }
      if (a.witness && ctx.index.find(a.witness, scope).length === 0) {
        return abstain(
          'anchor_missing',
          `Witness ${describeLocator(a.witness)} not found in ${ctx.index.path(scope)}; its content no longer has the expected structure`,
          [],
          drift,
        );
      }
      const hits = ctx.index.find(a.match, scope);
      const count = a.count ?? { gte: 1 };
      const where = ctx.index.path(scope);
      const evidence = [ev('a11y', { locator: where, value: hits.slice(0, 10).map((h) => ctx.index.path(h)) })];
      const msg = `${hits.length} × ${describeLocator(a.match)} in ${where} (expected ${describeNumberCompare(count)})`;
      return compareNumber(hits.length, count) ? pass(msg, evidence, drift) : fail(msg, evidence, drift);
    }
    case 'value': {
      const read = readNormalized(ctx, a.source, a.normalize);
      if (isResult(read)) return read;
      if ('sameAs' in a.expect) return evaluateBinding(ctx, read, a.expect.sameAs);
      return withSeq(valueResult(read, a.expect), read.seq);
    }
    case 'url': {
      const ok = matchUrl(a.match, ctx.snapshot.page.url);
      // A URL elsewhere is a route not taken; on the route, a wrong query parameter still fails.
      if (!ok && ctx.routeMissing && !onUrlRoute(a.match, ctx.snapshot.page.url))
        return abstain(
          'route_missing',
          `page URL ${ctx.snapshot.page.url} is not on ${describeUrlMatch({ path: a.match.path!, ...(a.match.origin ? { origin: a.match.origin } : {}) })}; ${ROUTE_HINT}`,
          [ev('url', { value: ctx.snapshot.page.url })],
        );
      const evidence = [ev('url', { value: ctx.snapshot.page.url })];
      const msg = `page URL ${ctx.snapshot.page.url} ${ok ? 'matches' : 'does not match'} ${describeUrlMatch(a.match)}`;
      return ok ? pass(msg, evidence) : fail(msg, evidence);
    }
    case 'request': {
      const log = ctx.snapshot.network;
      if (!log) return abstain('evidence_unavailable', 'network log was not recorded');
      const results = log.map((e) => [e, matchRequest(a.match, e)] as const);
      const hits = results.filter(([, r]) => r === 'yes').map(([e]) => e);
      const unknown = results.filter(([, r]) => r === 'unknown').length;
      const count = a.count ?? { gte: 1 };
      const desc = describeRequestMatch(a.match);
      const evidence = [
        ev('network', {
          locator: desc,
          value: hits.slice(0, 10).map((e) => `#${e.seq} ${e.method} ${e.url} → ${e.status ?? e.failure ?? 'pending'}`),
        }),
      ];
      const lo = compareNumber(hits.length, count);
      // The true count lies in [hits, hits + unknown]; decide only if both ends agree.
      if (unknown > 0 && lo !== compareNumber(hits.length + unknown, count))
        return abstain(
          'value_unavailable',
          `${hits.length} request(s) match ${desc} and ${unknown} could not be fully read (expected ${describeNumberCompare(count)})`,
          evidence,
        );
      // No matching request at all: with onMissing "abstain" that is a route not taken. One
      // too few (a partial completion) or too many is outcome evidence and still fails.
      if (!lo && hits.length === 0 && unknown === 0 && ctx.routeMissing)
        return abstain('route_missing', `no request matches ${desc}; ${ROUTE_HINT}`, evidence);
      if (!lo)
        return withSeq(
          fail(`${hits.length} request(s) match ${desc} (expected ${describeNumberCompare(count)})`, evidence),
          latest(...hits.map((e) => e.seq)),
        );
      return withSeq(pass(`${hits.length} request(s) match ${desc}`, evidence), latest(...hits.map((e) => e.seq)));
    }
    case 'each':
      return evaluateEach(ctx, a);
    case 'page':
      return evaluatePage(ctx, a);
    case 'allOf':
    case 'anyOf': {
      const all = a.of.map((s) => evaluateAssertion(ctx, s));
      let subs = all;
      // anyOf over alternative routes: a branch whose route the run did not take gives way to
      // those whose route it took, so the route it took decides (and can fail).
      if (a.kind === 'anyOf' && ctx.routeMissing) {
        const taken: Seq[] = all.filter((s) => s.reason !== 'route_missing');
        // Several routes taken: the one whose request came last left the final state, so it
        // decides, and an earlier route cannot pass a value a later one overwrote.
        const last = latest(...taken.map((s) => s.seq));
        if (taken.length) subs = taken.filter((s) => s.seq === undefined || s.seq === last);
      }
      const status = a.kind === 'allOf' ? kleeneAnd(subs.map((s) => s.status)) : kleeneOr(subs.map((s) => s.status));
      const relevant = subs.filter((s) => s.status === status);
      const evidence = (status === 'abstain' ? subs : relevant).flatMap((s) => s.evidence);
      const drift = all.flatMap((s) => s.drift);
      const message = `${a.kind}: ${all.map((s) => `[${s.status}] ${s.message}`).join(' | ')}`;
      if (status === 'abstain') {
        const reasons = [...new Set(subs.filter((s) => s.status === 'abstain').map((s) => s.reason))];
        return abstain(
          reasons.length === 1 && reasons[0] ? reasons[0] : 'subcheck_abstained',
          message,
          evidence,
          drift,
        );
      }
      return withSeq({ status, message, evidence, drift }, latest(...(subs as Seq[]).map((s) => s.seq)));
    }
  }
}

/** A plain value comparison (no binding) on a value that was read. */
function valueResult(read: Normalized, expect: Comparison): AssertionResult {
  if (!read.value) {
    // Normalizers do not apply to an absent value; only an expectation of null/absence passes.
    const ok = ('equals' in expect && expect.equals === null) || ('oneOf' in expect && expect.oneOf.includes(null));
    const msg = `${read.evidence.locator} is not set`;
    return ok ? pass(msg, [read.evidence]) : fail(msg, [read.evidence]);
  }
  const evidence = [read.evidence];
  try {
    const c = compare(read.value, expect);
    return c.ok ? pass(c.message, evidence, read.drift) : fail(c.message, evidence, read.drift);
  } catch (e) {
    if (e instanceof NormalizeError) return abstain(e.reason, e.message, evidence, read.drift);
    throw e;
  }
}

/** Per-record results shown in a message; the rest are counted. */
const SHOWN_RECORDS = 5;

/**
 * `each`: the scope and witness are anchors (missing → abstain); the number of records is
 * outcome evidence (outside `count` → fail); then the nested assertion must hold inside every
 * record, combined with strong Kleene conjunction.
 */
function evaluateEach(ctx: EvalCtx, a: Extract<Assertion, { kind: 'each' }>): AssertionResult {
  let scope = ctx.record ?? ctx.index.root;
  let drift: string[] = [];
  if (a.scope) {
    const r = resolve(ctx, a.scope);
    if (isResult(r)) return r;
    scope = r.node;
    drift = r.drift;
  }
  const where = ctx.index.path(scope);
  // The witness is an anchor: missing or ambiguous, the check cannot tell which structure it reads.
  const witnesses = a.witness ? ctx.index.find(a.witness, scope).length : 1;
  if (a.witness && witnesses === 0)
    return abstain(
      'anchor_missing',
      `Witness ${describeLocator(a.witness)} not found in ${where}; its content no longer has the expected structure`,
      [],
      drift,
    );
  if (a.witness && witnesses > 1)
    return abstain(
      'anchor_ambiguous',
      `Witness ${describeLocator(a.witness)} matches ${witnesses} nodes in ${where}; it must identify one`,
      [],
      drift,
    );
  const records = ctx.index.records(a.match, scope);
  const count = a.count ?? { gte: 1 };
  const what = `${records.length} record(s) ${describeLocator(a.match)} in ${where}`;
  if (!compareNumber(records.length, count))
    return fail(
      `${what} (expected ${describeNumberCompare(count)})`,
      [ev('a11y', { locator: where, value: records.slice(0, 10).map((r) => ctx.index.path(r)) })],
      drift,
    );
  const subs = records.map((record) => ({ record, r: evaluateAssertion({ ...ctx, record }, a.assert) }));
  const status = kleeneAnd(subs.map((s) => s.r.status));
  // Show the records that decided: the failing ones, the abstaining ones, or all when passing.
  const deciding = status === 'pass' ? subs : subs.filter((s) => s.r.status === status);
  const shown = deciding
    .slice(0, SHOWN_RECORDS)
    .map((s) => `[${s.r.status}] ${ctx.index.path(s.record)}: ${s.r.message}`);
  if (deciding.length > SHOWN_RECORDS) shown.push(`… ${deciding.length - SHOWN_RECORDS} more`);
  const message = `each of ${what}: ${shown.join(' | ')}`;
  const evidence = deciding.slice(0, 10).flatMap((s) => s.r.evidence);
  const allDrift = [...new Set([...drift, ...subs.flatMap((s) => s.r.drift)])];
  if (status === 'abstain') {
    const reasons = [...new Set(deciding.map((s) => s.r.reason))];
    return abstain(reasons.length === 1 && reasons[0] ? reasons[0] : 'subcheck_abstained', message, evidence, allDrift);
  }
  return { status, message, evidence, drift: allDrift };
}

/** Indexes of other pages' trees, built once per tree. */
const pageIndexes = new WeakMap<AXNode, AXIndex>();

/** The open pages of a snapshot: the active page first, then the others. */
export function openPages(s: EvidenceSnapshot): PageView[] {
  return [{ url: s.page.url, title: s.page.title, a11y: s.a11y, text: s.text }, ...(s.pages ?? [])];
}

/**
 * The context of the open page `match` selects: the snapshot seen as if that page were the
 * active one (its URL, title, tree and text), with the rest (network, storage, probes)
 * unchanged. A result instead when no page or several pages match, or the page could not be read.
 */
export function pageContext(ctx: EvalCtx, match: PageMatch): EvalCtx | AssertionResult {
  const s = ctx.snapshot;
  const views = openPages(s);
  const hits = views.filter((v) => matchPage(match, v));
  const what = describePageMatch(match);
  const seen = views.map((v) => v.url);
  // With onMissing "abstain", a page the run never opened is a route it did not take (ADR 0011).
  if (hits.length === 0)
    return abstain(
      ctx.routeMissing ? 'route_missing' : 'anchor_missing',
      `No open page matches ${what} (open: ${seen.join(', ')})`,
      [ev('url', { value: seen })],
    );
  if (hits.length > 1)
    return abstain(
      'anchor_ambiguous',
      `${hits.length} open pages match ${what}: ${hits.map((v) => v.url).join(', ')}`,
      [ev('url', { value: hits.map((v) => v.url) })],
    );
  const v = hits[0]!;
  if (v.unavailable) return abstain('evidence_unavailable', `the open page ${v.url} could not be read`);
  const route = ctx.routeMissing ? { routeMissing: true } : {};
  if (v.a11y === s.a11y) return { snapshot: s, index: ctx.index, ...route };
  let index = pageIndexes.get(v.a11y);
  if (!index) pageIndexes.set(v.a11y, (index = new AXIndex(v.a11y)));
  return { snapshot: { ...s, page: { url: v.url, title: v.title }, a11y: v.a11y, text: v.text }, index, ...route };
}

/** `page`: the nested assertion reads the open page `match` selects; selecting it is an anchor. */
function evaluatePage(ctx: EvalCtx, a: Extract<Assertion, { kind: 'page' }>): AssertionResult {
  const sub = pageContext(ctx, a.match);
  if (isResult(sub)) return sub;
  const r = evaluateAssertion(sub, a.assert);
  return { ...r, message: `on page ${sub.snapshot.page.url}: ${r.message}` };
}

// ---------------------------------------------------------------------------
// Check sets
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** Compute snapshot and check-set digests (default true). Stress testing skips them for speed. */
  digests?: boolean;
}

export function evaluate(checkSet: CheckSet, snapshot: EvidenceSnapshot, opts: EvaluateOptions = {}): Outcome {
  const ctx: EvalCtx = { snapshot, index: new AXIndex(snapshot.a11y) };

  const checks: CheckResult[] = checkSet.checks.map((c) => {
    let r: AssertionResult;
    try {
      r = evaluateAssertion(c.onMissing === 'abstain' ? { ...ctx, routeMissing: true } : ctx, c.assert);
    } catch (e) {
      // Defensive: a check that throws must never decide. Validation should prevent this.
      r = abstain('type_mismatch', `check raised an error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { seq: _seq, ...result } = r as Seq;
    return { check: c.id, requirement: c.requirement, description: c.description, ...result };
  });

  const requirements: RequirementResult[] = checkSet.requirements.map((req) => {
    const mine = checks.filter((c) => c.requirement === req.id);
    const base = { requirement: req.id, kind: req.kind, text: req.text, checks: mine.map((c) => c.check) };
    if (mine.length === 0) return { ...base, status: 'abstain', reason: 'uncovered' };
    const status = kleeneAnd(mine.map((c) => c.status));
    if (status !== 'abstain') return { ...base, status };
    const reasons = [...new Set(mine.filter((c) => c.status === 'abstain').map((c) => c.reason))];
    return { ...base, status, reason: reasons.length === 1 && reasons[0] ? reasons[0] : 'subcheck_abstained' };
  });

  const hard = kleeneAnd(requirements.filter((r) => r.kind === 'hard').map((r) => r.status));
  const verdict = hard === 'pass' ? 'success' : hard;

  return {
    verdict,
    checkSet: {
      id: checkSet.id,
      version: checkSet.version,
      digest: opts.digests === false ? '' : checkSetDigest(checkSet),
    },
    snapshot: {
      digest: opts.digests === false ? '' : snapshotDigest(snapshot),
      url: snapshot.page.url,
      capturedAt: snapshot.capturedAt,
    },
    requirements,
    checks,
    drift: checks.flatMap((c) => [...new Set(c.drift)].map((locator) => ({ check: c.check, locator }))),
  };
}
