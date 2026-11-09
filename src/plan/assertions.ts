/**
 * Assertions prepared for evaluation (ADR 0015). `compileAssertion(a)` turns an assertion into
 * a function of an evaluation context, made once per assertion object: locators, text and URL
 * matches, request matchers, normalizer chains and messages' descriptions are prepared on
 * first use and kept. It is the only implementation of assertion semantics; `evaluate` and
 * `evaluateAssertion` run it.
 *
 * Everything prepared is prepared at the point where it used to be computed on every
 * evaluation, and preparation that throws is retried (see `once`), so a malformed check fails
 * exactly where and how it always did.
 */
import type {
  AbstainReason,
  Assertion,
  AssertionResult,
  Channel,
  Comparison,
  Evidence,
  EvidenceSnapshot,
  Json,
  Normalizer,
  PageMatch,
  PageView,
  Status,
  Target,
  Tolerance,
  ValueSource,
} from '../types.ts';
import { CHANNEL_TRUST, textSourceChannel } from '../types.ts';
import { canonical, describeTextMatch, stripGlobal, textTest, type TextTest } from '../text.ts';
import {
  AXIndex,
  compileLocator,
  readNodeField,
  resolveLocators,
  targetLocators,
  type CompiledLocator,
  type INode,
} from '../runtime/axindex.ts';
import { compare, compareNumber, compareValues, describeNumberCompare, jsonPointer } from '../runtime/compare.ts';
import {
  NormalizeError,
  applySteps,
  fromJson,
  resolveNormalizers,
  toJson,
  type NormalizerStep,
  type TypedValue,
} from '../runtime/values.ts';
import {
  describePageMatch,
  describeRequestMatch,
  describeUrlMatch,
  onUrlRoute,
  pageMatcher,
  requestMatcher,
  truncated,
  urlMatcher,
  type MatchResult,
} from '../runtime/network.ts';
import { once, regExp } from '../runtime/once.ts';
import { networkTable, parseUrl } from '../store/network.ts';
import { cookiesByName } from '../store/store.ts';
import type { NetworkEntry } from '../types.ts';

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

/** An assertion prepared for evaluation. */
export type Run = (ctx: EvalCtx) => AssertionResult;

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
export const abstain = (
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

const isResult = (x: unknown): x is AssertionResult => !!x && typeof x === 'object' && 'status' in x;

/** A target's locators, prepared on first use. */
const targetOf = (t: Target) => once(() => targetLocators(t).map(compileLocator));
/** A locator, prepared on first use. */
const locatorOf = (l: Parameters<typeof compileLocator>[0]) => once(() => compileLocator(l));

function resolve(ctx: EvalCtx, locs: CompiledLocator[]): { node: INode; drift: string[] } | AssertionResult {
  const r = resolveLocators(ctx.index, locs, ctx.record ?? ctx.index.root);
  if (!r.ok) return abstain(r.reason, r.message, [], r.drift);
  return { node: r.node, drift: r.drift };
}

/**
 * A scope: resolved like a target, but an iframe whose frame could not be read (ADR 0012)
 * has no content to search, so a check scoped to it abstains instead of counting nothing.
 */
function resolveScope(ctx: EvalCtx, locs: CompiledLocator[]): { node: INode; drift: string[] } | AssertionResult {
  const r = resolve(ctx, locs);
  if (isResult(r) || r.node.node.role !== 'iframe' || r.node.node.props?.frame !== 'unavailable') return r;
  return abstain('evidence_unavailable', `the frame ${ctx.index.path(r.node)} could not be read`, [], r.drift);
}

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
export type Seq = AssertionResult & { seq?: number };
const withSeq = (r: AssertionResult, seq: number | undefined): Seq => (seq === undefined ? r : { ...r, seq });
const latest = (...xs: (number | undefined)[]) => {
  const ns = xs.filter((x): x is number => x !== undefined);
  return ns.length ? Math.max(...ns) : undefined;
};
const ABSENT: TypedValue = { type: 'json', value: null };

/** Page text with runs of horizontal whitespace collapsed, as an unscoped text source reads it. */
const collapsed = new Map<string, string>();
function collapseText(text: string): string {
  if (typeof text !== 'string') return (text as string).replace(/[^\S\n]+/g, ' ');
  let c = collapsed.get(text);
  if (c === undefined) {
    if (collapsed.size >= 64) collapsed.clear();
    collapsed.set(text, (c = text.replace(/[^\S\n]+/g, ' ')));
  }
  return c;
}

type Reader = (ctx: EvalCtx) => Read;

const readers = new WeakMap<object, Reader>();

/** A value source prepared for reading, made once per source object. */
function sourceReader(src: ValueSource): Reader {
  if (!src || typeof src !== 'object') return makeReader(src);
  let r = readers.get(src);
  if (!r) readers.set(src, (r = makeReader(src)));
  return r;
}

/** Entries matching a request match: hits and the number that could not be decided, in log order. */
function matchLog(
  log: NetworkEntry[],
  m: Parameters<typeof requestMatcher>[0],
): { hits: NetworkEntry[]; unknown: number } {
  const hits: NetworkEntry[] = [];
  let unknown = 0;
  if (log.length === 0) return { hits, unknown };
  const matcher = requestMatcher(m);
  const table = networkTable(log);
  const methods = matcher.methods();
  const ids = methods === undefined ? table.ids() : table.withMethods(methods);
  for (let i = 0; i < ids.length; i++) {
    const e = log[ids[i]!]!;
    const r: MatchResult = matcher.test(e);
    if (r === 'yes') hits.push(e);
    else if (r === 'unknown') unknown++;
  }
  return { hits, unknown };
}

function makeReader(src: ValueSource): Reader {
  switch (src.from) {
    case 'node': {
      const target = targetOf(src.target);
      return (ctx) => {
        const r = resolve(ctx, target());
        if (isResult(r)) return r;
        const raw = readNodeField(ctx.index, r.node, src.field);
        const locator = ctx.index.path(r.node);
        if (raw === undefined)
          return abstain('value_unavailable', `${locator} has no ${src.field}`, [ev('a11y', { locator })], r.drift);
        return { value: { type: 'string', value: raw }, evidence: ev('a11y', { locator, value: raw }), drift: r.drift };
      };
    }
    case 'text': {
      const scope = src.scope !== undefined ? targetOf(src.scope) : undefined;
      return (ctx) => {
        const snap = ctx.snapshot;
        let text = snap.text;
        let drift: string[] = [];
        let locator = 'document text';
        let channel: Channel = 'text';
        // Inside a record, an unscoped text source reads the record's text, not the page's.
        const scoped = textSourceChannel(src, ctx.record !== undefined) === 'a11y';
        if (scoped) {
          let node = ctx.record!;
          if (src.scope) {
            const r = resolveScope(ctx, scope!());
            if (isResult(r)) return r;
            node = r.node;
            drift = r.drift;
          }
          // Scoped text is derived from accessible names, so it is canonicalized like a node's text.
          text = ctx.index.canonicalText(node);
          locator = `text of ${ctx.index.path(node)}`;
          channel = 'a11y';
        }
        const m = regExp(src.pattern, stripGlobal(src.flags)).exec(scoped ? text : collapseText(text));
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
      };
    }
    case 'url':
      return (ctx) => {
        const snap = ctx.snapshot;
        const parsed = parseUrl(snap.page.url);
        if (!parsed) return abstain('value_unavailable', `page URL is not parseable: ${snap.page.url}`);
        const u = parsed.url;
        let v: string | null;
        if (typeof src.part === 'object') v = u.searchParams.get(src.part.param);
        else v = u[src.part];
        const what = typeof src.part === 'object' ? `query parameter ${src.part.param}` : `URL ${src.part}`;
        if (v === null) return abstain('value_unavailable', `${what} is absent`, [ev('url', { value: snap.page.url })]);
        return { value: { type: 'string', value: v }, evidence: ev('url', { locator: what, value: v }), drift: [] };
      };
    case 'request':
    case 'response': {
      const desc = once(() => describeRequestMatch(src.match));
      return (ctx) => {
        const snap = ctx.snapshot;
        if (!snap.network) return abstain('evidence_unavailable', 'network log was not recorded');
        const { hits, unknown } = matchLog(snap.network, src.match);
        desc();
        if (unknown > 0)
          return abstain('value_unavailable', `${unknown} candidate request(s) for ${desc()} could not be fully read`, [
            ev('network'),
          ]);
        if (hits.length === 0)
          return ctx.routeMissing
            ? abstain('route_missing', `no request matches ${desc()}; ${ROUTE_HINT}`, [ev('network')])
            : abstain('value_unavailable', `no request matches ${desc()}`, [ev('network')]);
        const pick = src.pick ?? 'only';
        if (pick === 'only' && hits.length > 1)
          return abstain('value_ambiguous', `${hits.length} requests match ${desc()}; use pick "first" or "last"`, [
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
      };
    }
    case 'storage':
      return (ctx) => {
        const snap = ctx.snapshot;
        const before = src.at === 'before';
        if (before && !snap.baseline)
          return abstain('evidence_unavailable', 'no baseline was captured before the task');
        const storage = before ? snap.baseline!.storage : snap.storage;
        if (!storage)
          return abstain('evidence_unavailable', `storage was not captured${before ? ' before the task' : ''}`);
        const when = before ? ' (before)' : '';
        const pageOrigin = safeOrigin(snap.page.url);
        if (src.area === 'cookie') {
          const host = safeHost(src.origin ?? snap.page.url);
          const named = cookiesByName(storage).get(src.key) ?? [];
          const c = named.filter((cookie) => !host || domainMatches(host, cookie.domain));
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
      };
    case 'probe':
      return (ctx) => {
        const snap = ctx.snapshot;
        const before = src.at === 'before';
        if (before && !snap.baseline)
          return abstain('evidence_unavailable', 'no baseline was captured before the task');
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
      };
    default:
      // An unknown source reads nothing (and the evaluator throws on it, as it always did).
      return () => undefined as unknown as Read;
  }
}

function safeOrigin(u: string): string | null {
  return parseUrl(u)?.origin ?? null;
}
function safeHost(u: string): string | null {
  return parseUrl(u)?.url.hostname ?? null;
}
function domainMatches(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, '');
  return host === d || host.endsWith('.' + d);
}

/** A read and normalized value; `value` is undefined for an observed absence (normalizers do not run). */
type Normalized = { value?: TypedValue; evidence: Evidence; drift: string[]; seq?: number };

/** A source with its normalizer chain, both prepared. */
type NormalizedReader = (ctx: EvalCtx) => Normalized | AssertionResult;

function normalizedReader(src: ValueSource, steps: Normalizer[] | undefined): NormalizedReader {
  const read = once(() => sourceReader(src));
  const chain = once((): readonly NormalizerStep[] => resolveNormalizers(steps));
  return (ctx) => {
    const r = read()(ctx);
    if (isResult(r)) return r;
    if (r.absent) return { evidence: r.evidence, drift: r.drift };
    const seq = r.seq;
    let v: TypedValue;
    try {
      v = applySteps(r.value, chain());
    } catch (e) {
      if (e instanceof NormalizeError) return abstain(e.reason, e.message, [r.evidence], r.drift);
      throw e;
    }
    const evidence = { ...r.evidence, value: toJson(v) };
    if (steps?.length)
      evidence.locator = `${r.evidence.locator ?? ''} (raw ${JSON.stringify(r.evidence.value)})`.trim();
    return { value: v, evidence, drift: r.drift, ...(seq !== undefined ? { seq } : {}) };
  };
}

/** The value a source gives after `steps`, as JSON; undefined when it cannot be read (or is an observed absence). */
export function readValue(ctx: EvalCtx, src: ValueSource, steps: Normalizer[] | undefined): Json | undefined {
  const r = normalizedReader(src, steps)(ctx);
  return isResult(r) || !r.value ? undefined : toJson(r.value);
}

/** Both sides of a `sameAs` binding, read and normalized; undefined when either cannot be read or is absent. */
export function bindingSides(
  ctx: EvalCtx,
  a: Extract<Assertion, { kind: 'value' }>,
): { left: TypedValue; right: TypedValue } | undefined {
  if (!('sameAs' in a.expect)) return undefined;
  const left = normalizedReader(a.source, a.normalize)(ctx);
  const right = normalizedReader(a.expect.sameAs.source, a.expect.sameAs.normalize)(ctx);
  if (isResult(left) || isResult(right) || !left.value || !right.value) return undefined;
  return { left: left.value, right: right.value };
}

function bindingResult(left: Normalized, right: Normalized | AssertionResult, tolerance?: Tolerance): AssertionResult {
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
    const c = compareValues(left.value, right.value, tolerance);
    const msg = `${c.message} (${where})`;
    return c.ok ? pass(msg, evidence, drift) : fail(msg, evidence, drift);
  } catch (e) {
    if (e instanceof NormalizeError) return abstain(e.reason, e.message, evidence, drift);
    throw e;
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

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const runs = new WeakMap<object, Run>();

/** The prepared form of `a`, made once per assertion object. */
export function compileAssertion(a: Assertion): Run {
  if (!a || typeof a !== 'object') return makeRun(a);
  let r = runs.get(a);
  if (!r) runs.set(a, (r = makeRun(a)));
  return r;
}

/** A nested assertion, prepared when it is first evaluated (so evaluation order decides what fails first). */
const lazyRun = (a: Assertion): Run => {
  let r: Run | undefined;
  return (ctx) => (r ??= compileAssertion(a))(ctx);
};

/** Evaluate `a` in `ctx` (prepared once per assertion object). */
export function evaluateAssertion(ctx: EvalCtx, a: Assertion): AssertionResult {
  return compileAssertion(a)(ctx);
}

function makeRun(a: Assertion): Run {
  switch (a.kind) {
    case 'state':
      return stateRun(a);
    case 'contains':
      return containsRun(a);
    case 'value': {
      const read = normalizedReader(a.source, a.normalize);
      const binding = once(() => ('sameAs' in a.expect ? a.expect.sameAs : null));
      const right = once(() => normalizedReader(binding()!.source, binding()!.normalize));
      return (ctx) => {
        const r = read(ctx);
        if (isResult(r)) return r;
        const other = binding();
        if (other) {
          // A `sameAs` binding: either side unreadable abstains; an observed absence on either side fails.
          const o = right()(ctx);
          if (isResult(o)) return bindingResult(r, o, other.tolerance);
          return withSeq(bindingResult(r, o, other.tolerance), latest(r.seq, o.seq));
        }
        return withSeq(valueResult(r, a.expect), r.seq);
      };
    }
    case 'url': {
      const matcher = once(() => urlMatcher(a.match));
      const desc = once(() => describeUrlMatch(a.match));
      return (ctx) => {
        const href = ctx.snapshot.page.url;
        const ok = matcher()(href);
        // A URL elsewhere is a route not taken; on the route, a wrong query parameter still fails.
        if (!ok && ctx.routeMissing && !onUrlRoute(a.match, href))
          return abstain(
            'route_missing',
            `page URL ${href} is not on ${describeUrlMatch({ path: a.match.path!, ...(a.match.origin ? { origin: a.match.origin } : {}) })}; ${ROUTE_HINT}`,
            [ev('url', { value: href })],
          );
        const evidence = [ev('url', { value: href })];
        const msg = `page URL ${href} ${ok ? 'matches' : 'does not match'} ${desc()}`;
        return ok ? pass(msg, evidence) : fail(msg, evidence);
      };
    }
    case 'request': {
      const desc = once(() => describeRequestMatch(a.match));
      return (ctx) => {
        const log = ctx.snapshot.network;
        if (!log) return abstain('evidence_unavailable', 'network log was not recorded');
        const { hits, unknown } = matchLog(log, a.match);
        const count = a.count ?? { gte: 1 };
        const evidence = [
          ev('network', {
            locator: desc(),
            value: hits
              .slice(0, 10)
              .map((e) => `#${e.seq} ${e.method} ${e.url} → ${e.status ?? e.failure ?? 'pending'}`),
          }),
        ];
        const lo = compareNumber(hits.length, count);
        // The true count lies in [hits, hits + unknown]; decide only if both ends agree.
        if (unknown > 0 && lo !== compareNumber(hits.length + unknown, count))
          return abstain(
            'value_unavailable',
            `${hits.length} request(s) match ${desc()} and ${unknown} could not be fully read (expected ${describeNumberCompare(count)})`,
            evidence,
          );
        // No matching request at all: with onMissing "abstain" that is a route not taken. One
        // too few (a partial completion) or too many is outcome evidence and still fails.
        if (!lo && hits.length === 0 && unknown === 0 && ctx.routeMissing)
          return abstain('route_missing', `no request matches ${desc()}; ${ROUTE_HINT}`, evidence);
        if (!lo)
          return withSeq(
            fail(`${hits.length} request(s) match ${desc()} (expected ${describeNumberCompare(count)})`, evidence),
            latest(...hits.map((e) => e.seq)),
          );
        return withSeq(pass(`${hits.length} request(s) match ${desc()}`, evidence), latest(...hits.map((e) => e.seq)));
      };
    }
    case 'each':
      return eachRun(a);
    case 'sequence':
      return sequenceRun(a);
    case 'page': {
      const sub = lazyRun(a.assert);
      return (ctx) => {
        const pc = pageContext(ctx, a.match);
        if (isResult(pc)) return pc;
        const r = sub(pc);
        return { ...r, message: `on page ${pc.snapshot.page.url}: ${r.message}` };
      };
    }
    case 'allOf':
    case 'anyOf': {
      const parts = once(() => a.of.map(lazyRun));
      return (ctx) => {
        const all: Seq[] = parts().map((s) => s(ctx));
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
        return withSeq({ status, message, evidence, drift }, latest(...subs.map((s) => s.seq)));
      };
    }
    default:
      // An unknown kind gives no result, as the switch over kinds always did.
      return () => undefined as unknown as AssertionResult;
  }
}

const STATES = ['checked', 'pressed', 'selected', 'expanded', 'disabled'] as const;
const TEXTS = ['name', 'value', 'text'] as const;

function stateRun(a: Extract<Assertion, { kind: 'state' }>): Run {
  const target = targetOf(a.target);
  const tests: Partial<Record<(typeof TEXTS)[number], TextTest>> = {};
  const testFor = (k: (typeof TEXTS)[number]) => (tests[k] ??= textTest(a.expect[k]!));
  return (ctx) => {
    const r = resolve(ctx, target());
    if (isResult(r)) return r;
    const n = r.node.node;
    const locator = ctx.index.path(r.node);
    const problems: string[] = [];
    const observed: Record<string, Json> = {};
    for (const k of STATES) {
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
    for (const k of TEXTS) {
      const m = a.expect[k];
      if (m === undefined) continue;
      const actual = k === 'text' ? ctx.index.text(r.node) : n[k];
      observed[k] = actual ?? null;
      // matchText(m, actual), with the node's canonical name and text cached by the index.
      const canon =
        actual === undefined
          ? undefined
          : k === 'text'
            ? ctx.index.canonicalText(r.node)
            : k === 'name'
              ? ctx.index.canonicalName(r.node)!
              : canonical(actual);
      if (canon === undefined || !testFor(k)(canon))
        problems.push(`${k} is ${JSON.stringify(actual ?? null)}, expected ${describeTextMatch(m)}`);
    }
    const evidence = [ev('a11y', { locator, value: observed })];
    return problems.length
      ? fail(`${locator}: ${problems.join('; ')}`, evidence, r.drift)
      : pass(`${locator} has the expected state`, evidence, r.drift);
  };
}

function containsRun(a: Extract<Assertion, { kind: 'contains' }>): Run {
  const scopeTarget = a.scope ? targetOf(a.scope) : undefined;
  const witness = a.witness ? locatorOf(a.witness) : undefined;
  const match = locatorOf(a.match);
  return (ctx) => {
    let scope = ctx.record ?? ctx.index.root;
    let drift: string[] = [];
    if (a.scope) {
      const r = resolveScope(ctx, scopeTarget!());
      if (isResult(r)) return r;
      scope = r.node;
      drift = r.drift;
    }
    if (a.witness && witness!().find(ctx.index, scope).length === 0) {
      return abstain(
        'anchor_missing',
        `Witness ${witness!().desc} not found in ${ctx.index.path(scope)}; its content no longer has the expected structure`,
        [],
        drift,
      );
    }
    const hits = match().find(ctx.index, scope);
    const count = a.count ?? { gte: 1 };
    const where = ctx.index.path(scope);
    const evidence = [ev('a11y', { locator: where, value: hits.slice(0, 10).map((h) => ctx.index.path(h)) })];
    const msg = `${hits.length} × ${match().desc} in ${where} (expected ${describeNumberCompare(count)})`;
    return compareNumber(hits.length, count) ? pass(msg, evidence, drift) : fail(msg, evidence, drift);
  };
}

/** Per-record results shown in a message; the rest are counted. */
const SHOWN_RECORDS = 5;

/**
 * `each`: the scope and witness are anchors (missing → abstain); the number of records is
 * outcome evidence (outside `count` → fail); then the nested assertion must hold inside every
 * record, combined with strong Kleene conjunction.
 */
function eachRun(a: Extract<Assertion, { kind: 'each' }>): Run {
  const scopeTarget = a.scope ? targetOf(a.scope) : undefined;
  const witness = a.witness ? locatorOf(a.witness) : undefined;
  const match = locatorOf(a.match);
  const sub = lazyRun(a.assert);
  return (ctx) => {
    let scope = ctx.record ?? ctx.index.root;
    let drift: string[] = [];
    if (a.scope) {
      const r = resolveScope(ctx, scopeTarget!());
      if (isResult(r)) return r;
      scope = r.node;
      drift = r.drift;
    }
    const where = ctx.index.path(scope);
    // The witness is an anchor: missing or ambiguous, the check cannot tell which structure it reads.
    const witnesses = a.witness ? witness!().find(ctx.index, scope).length : 1;
    if (a.witness && witnesses === 0)
      return abstain(
        'anchor_missing',
        `Witness ${witness!().desc} not found in ${where}; its content no longer has the expected structure`,
        [],
        drift,
      );
    if (a.witness && witnesses > 1)
      return abstain(
        'anchor_ambiguous',
        `Witness ${witness!().desc} matches ${witnesses} nodes in ${where}; it must identify one`,
        [],
        drift,
      );
    const records = ctx.index.recordsOf(match(), scope);
    const count = a.count ?? { gte: 1 };
    const what = `${records.length} record(s) ${match().desc} in ${where}`;
    if (!compareNumber(records.length, count))
      return fail(
        `${what} (expected ${describeNumberCompare(count)})`,
        [ev('a11y', { locator: where, value: records.slice(0, 10).map((r) => ctx.index.path(r)) })],
        drift,
      );
    const subs = records.map((record) => ({ record, r: sub({ ...ctx, record }) }));
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
      return abstain(
        reasons.length === 1 && reasons[0] ? reasons[0] : 'subcheck_abstained',
        message,
        evidence,
        allDrift,
      );
    }
    return { status, message, evidence, drift: allDrift };
  };
}

// ---------------------------------------------------------------------------
// Order (ADR 0024)
// ---------------------------------------------------------------------------

/** Where the events matching one step are: definitely (`yes`) and possibly (`unknown`), ascending. */
interface StepHits {
  yes: number[];
  unknown: number[];
}

/** A trajectory event as messages show it: its order index, and the request or URL. */
function describeEvent(snapshot: EvidenceSnapshot, i: number, bySeq: Map<number, NetworkEntry>): string {
  const e = snapshot.trajectory![i]!;
  if (e.type === 'navigation') return `[${i}] navigation to ${e.url}`;
  const n = bySeq.get(e.seq);
  return n ? `[${i}] #${n.seq} ${n.method} ${n.url}` : `[${i}] #${e.seq}`;
}

/** The network log by `seq`, built once per log. */
const logsBySeq = new WeakMap<object, Map<number, NetworkEntry>>();
function bySeqOf(log: NetworkEntry[] | null): Map<number, NetworkEntry> {
  if (!log) return new Map();
  let m = logsBySeq.get(log);
  if (!m) logsBySeq.set(log, (m = new Map(log.map((e) => [e.seq, e]))));
  return m;
}

/**
 * Where the events matching each step of a sequence are in the snapshot's trajectory. A
 * request event matches through its network entry (three-valued, as for `request`); one whose
 * entry the log does not hold matches nothing. A navigation event matches a URL step.
 * @internal Exported for the stress test's reorder mutants.
 */
export function sequenceHits(s: EvidenceSnapshot, a: Extract<Assertion, { kind: 'sequence' }>): StepHits[] {
  const events = s.trajectory ?? [];
  const bySeq = bySeqOf(s.network);
  return a.steps.map((step) => {
    const hits: StepHits = { yes: [], unknown: [] };
    if ('request' in step) {
      const m = requestMatcher(step.request);
      events.forEach((e, i) => {
        if (e.type !== 'request') return;
        const entry = bySeq.get(e.seq);
        const r = entry ? m.test(entry) : 'no';
        if (r !== 'no') hits[r].push(i);
      });
    } else {
      const m = urlMatcher(step.url);
      events.forEach((e, i) => {
        if (e.type === 'navigation' && m(e.url)) hits.yes.push(i);
      });
    }
    return hits;
  });
}

const describeStep = (step: Extract<Assertion, { kind: 'sequence' }>['steps'][number]): string =>
  'request' in step
    ? `a request ${describeRequestMatch(step.request)}`
    : `a navigation to ${describeUrlMatch(step.url)}`;

/**
 * `sequence`: the first event of each step comes after the first event of the step before
 * (so every event of a step has one of the previous step before it); `strict`, also every
 * event of a step before the first event of the next. Events whose match is unknown (an
 * unreadable body) count both ways: the check decides only when every reading agrees, as
 * `request` does. No trajectory (or no network log, for request steps) abstains.
 */
function sequenceRun(a: Extract<Assertion, { kind: 'sequence' }>): Run {
  const descs = once(() => a.steps.map(describeStep));
  return (ctx) => {
    const s = ctx.snapshot;
    if (!s.trajectory)
      return abstain(
        'evidence_unavailable',
        'the trajectory (the order of requests and navigations) was not recorded; capture with the recorder option trajectory: true',
      );
    if (!s.network && a.steps.some((st) => 'request' in st))
      return abstain('evidence_unavailable', 'network log was not recorded');
    const d = descs();
    const hits = sequenceHits(s, a);
    const bySeq = bySeqOf(s.network);
    const show = (i: number) => describeEvent(s, i, bySeq);
    const evidence = hits.map((h, k) =>
      ev('request' in a.steps[k]! ? 'network' : 'url', {
        locator: `trajectory, step ${k + 1}: ${d[k]}`,
        value: [...h.yes, ...h.unknown]
          .toSorted((x, y) => x - y)
          .slice(0, 10)
          .map(show),
      }),
    );
    const INF = Number.POSITIVE_INFINITY;
    // First event of each step: at the earliest a possible one, at the latest the first definite one.
    const lo = hits.map((h) => Math.min(h.yes[0] ?? INF, h.unknown[0] ?? INF));
    const hi = hits.map((h) => h.yes[0] ?? INF);
    const lastYes = hits.map((h) => h.yes.at(-1) ?? -1);
    const lastAny = hits.map((h) => Math.max(h.yes.at(-1) ?? -1, h.unknown.at(-1) ?? -1));
    const n = a.steps.length;
    const seqOf = (i: number) => {
      const e = s.trajectory![i];
      return e?.type === 'request' ? e.seq : undefined;
    };
    const seq = latest(...hi.filter((i) => i < INF).map(seqOf));

    // A definite violation fails, whatever else is unknown: a step's first event comes at or
    // before every possible first event of the step before it, or (strict) a definite event of
    // a step comes at or after the first event of the next.
    for (let k = 0; k + 1 < n; k++) {
      if (hi[k + 1] === INF) continue;
      if (lo[k] === INF)
        return withSeq(
          fail(
            `${d[k + 1]} occurred (${show(hi[k + 1]!)}) without ${d[k]} before it: no event matches step ${k + 1}`,
            evidence,
          ),
          seq,
        );
      if (lo[k]! >= hi[k + 1]!)
        return withSeq(
          fail(
            `${d[k + 1]} first occurred at ${show(hi[k + 1]!)}, before ${d[k]} (first at ${show(lo[k]!)})`,
            evidence,
          ),
          seq,
        );
      if (a.strict && lastYes[k]! >= hi[k + 1]!)
        return withSeq(
          fail(
            `${d[k]} occurred again at ${show(lastYes[k]!)}, after ${d[k + 1]} first occurred at ${show(hi[k + 1]!)} (strict order)`,
            evidence,
          ),
          seq,
        );
    }
    const absent = lo.findIndex((x) => x === INF);
    if (absent >= 0) {
      const none = lo.every((x) => x === INF);
      // No step occurred at all: with onMissing "abstain", a route the run did not take (ADR 0011).
      if (none && ctx.routeMissing)
        return abstain('route_missing', `no event matches any step of the sequence; ${ROUTE_HINT}`, evidence);
      return withSeq(fail(`no event matches step ${absent + 1}: ${d[absent]}`, evidence), seq);
    }
    const certain = hits.every((h) => h.yes.length > 0);
    let ordered = certain;
    for (let k = 0; ordered && k + 1 < n; k++) ordered = hi[k]! < lo[k + 1]! && (!a.strict || lastAny[k]! < lo[k + 1]!);
    if (!ordered)
      return abstain(
        'value_unavailable',
        `the order of ${d.join(' → ')} could not be decided: some candidate requests could not be fully read`,
        evidence,
      );
    return withSeq(pass(`in ${a.strict ? 'strict ' : ''}order: ${hi.map((i) => show(i)).join(' → ')}`, evidence), seq);
  };
}

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
  const test = pageMatcher(match);
  const hits = views.filter((v) => test(v));
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
  const index = AXIndex.of(v.a11y);
  return { snapshot: { ...s, page: { url: v.url, title: v.title }, a11y: v.a11y, text: v.text }, index, ...route };
}
