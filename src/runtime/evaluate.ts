import type {
  AbstainReason,
  Assertion,
  AssertionResult,
  CheckResult,
  CheckSet,
  Channel,
  EvidenceSnapshot,
  Evidence,
  Json,
  Outcome,
  RequirementResult,
  Status,
  Target,
  ValueSource,
} from '../types.ts';
import { CHANNEL_TRUST } from '../types.ts';
import { describeTextMatch, matchText, stripGlobal } from '../text.ts';
import { checkSetDigest, snapshotDigest } from '../snapshot/digest.ts';
import { AXIndex, describeLocator, readNodeField, resolveTarget, type INode } from './axindex.ts';
import { compare, compareNumber, describeNumberCompare, jsonPointer } from './compare.ts';
import { NormalizeError, applyNormalizers, fromJson, toJson, type TypedValue } from './values.ts';
import { describeRequestMatch, describeUrlMatch, matchRequest, matchUrl } from './network.ts';

interface Ctx {
  snapshot: EvidenceSnapshot;
  index: AXIndex;
}

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

function resolve(ctx: Ctx, target: Target): { node: INode; drift: string[] } | AssertionResult {
  const r = resolveTarget(ctx.index, target);
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
type Read = { value: TypedValue; evidence: Evidence; drift: string[]; absent?: boolean } | AssertionResult;
const ABSENT: TypedValue = { type: 'json', value: null };

function readSource(ctx: Ctx, src: ValueSource): Read {
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
      if (src.scope) {
        const r = resolve(ctx, src.scope);
        if (isResult(r)) return r;
        text = ctx.index.text(r.node);
        drift = r.drift;
        locator = `text of ${ctx.index.path(r.node)}`;
        channel = 'a11y';
      }
      const m = new RegExp(src.pattern, stripGlobal(src.flags)).exec(src.scope ? text : text.replace(/[^\S\n]+/g, ' '));
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
      if (hits.length === 0) return abstain('value_unavailable', `no request matches ${desc}`, [ev('network')]);
      const pick = src.pick ?? 'only';
      if (pick === 'only' && hits.length > 1)
        return abstain('value_ambiguous', `${hits.length} requests match ${desc}; use pick "first" or "last"`, [
          ev('network'),
        ]);
      const e = pick === 'last' ? hits[hits.length - 1]! : hits[0]!;
      const body = src.from === 'request' ? e.requestBody : e.responseBody;
      const locator = `${src.from} body of #${e.seq} ${e.method} ${e.url}${src.pointer ? ' at ' + src.pointer : ''}`;
      if (body === undefined || e.bodyTruncated)
        return abstain('value_unavailable', `${src.from} body of #${e.seq} was not captured`, [
          ev('network', { locator }),
        ]);
      const v = jsonPointer(body, src.pointer);
      if (v === undefined)
        return abstain('value_unavailable', `${src.pointer} not present in ${src.from} body of #${e.seq}`, [
          ev('network', { locator }),
        ]);
      return { value: fromJson(v), evidence: ev('network', { locator, value: v }), drift: [] };
    }
    case 'storage': {
      if (!snap.storage) return abstain('evidence_unavailable', 'storage was not captured');
      const pageOrigin = safeOrigin(snap.page.url);
      if (src.area === 'cookie') {
        const host = safeHost(src.origin ?? snap.page.url);
        const c = snap.storage.cookies.filter(
          (cookie) => cookie.name === src.key && (!host || domainMatches(host, cookie.domain)),
        );
        if (c.length === 0)
          return {
            value: ABSENT,
            evidence: ev('storage', { locator: `cookie ${src.key}`, value: null }),
            drift: [],
            absent: true,
          };
        if (c.length > 1 && new Set(c.map((x) => JSON.stringify(x.value))).size > 1)
          return abstain('value_ambiguous', `cookie ${src.key} has ${c.length} different values`, [
            ev('storage', { locator: `cookie ${src.key}` }),
          ]);
        const value = c[0]!.value;
        if (typeof value !== 'string')
          return abstain('evidence_unavailable', `cookie ${src.key} was redacted at capture time`, [
            ev('storage', { locator: `cookie ${src.key}` }),
          ]);
        return {
          value: { type: 'string', value },
          evidence: ev('storage', { locator: `cookie ${src.key}`, value }),
          drift: [],
        };
      }
      const origin = src.origin ? safeOrigin(src.origin) : pageOrigin;
      const area = snap.storage[src.area][origin ?? ''];
      const locator = `${src.area}Storage[${JSON.stringify(src.key)}] @ ${origin}`;
      if (!area || !Object.prototype.hasOwnProperty.call(area, src.key))
        return { value: ABSENT, evidence: ev('storage', { locator, value: null }), drift: [], absent: true };
      const value = area[src.key]!;
      return { value: { type: 'string', value }, evidence: ev('storage', { locator, value }), drift: [] };
    }
    case 'probe': {
      const p = snap.probes[src.probe];
      if (!p) return abstain('evidence_unavailable', `probe ${src.probe} was not run`);
      if (!p.ok)
        return abstain('probe_error', `probe ${src.probe} failed: ${p.error}`, [ev('probe', { locator: src.probe })]);
      const v = jsonPointer(p.value, src.pointer);
      const locator = `probe ${src.probe}${src.pointer ? ' at ' + src.pointer : ''}`;
      if (v === undefined)
        return abstain('value_unavailable', `${src.pointer} not present in result of probe ${src.probe}`, [
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

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export function evaluateAssertion(ctx: Ctx, a: Assertion): AssertionResult {
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
      let scope = ctx.index.root;
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
      const read = readSource(ctx, a.source);
      if (isResult(read)) return read;
      if (read.absent) {
        // Normalizers do not apply to an absent value; only an expectation of null/absence passes.
        const e = a.expect;
        const ok = ('equals' in e && e.equals === null) || ('oneOf' in e && e.oneOf.includes(null));
        const msg = `${read.evidence.locator} is not set`;
        return ok ? pass(msg, [read.evidence]) : fail(msg, [read.evidence]);
      }
      let v: TypedValue;
      try {
        v = applyNormalizers(read.value, a.normalize);
      } catch (e) {
        if (e instanceof NormalizeError) return abstain(e.reason, e.message, [read.evidence], read.drift);
        throw e;
      }
      const evidence = [{ ...read.evidence, value: toJson(v) }];
      if (a.normalize?.length)
        evidence[0]!.locator = `${read.evidence.locator ?? ''} (raw ${JSON.stringify(read.evidence.value)})`.trim();
      try {
        const c = compare(v, a.expect);
        return c.ok ? pass(c.message, evidence, read.drift) : fail(c.message, evidence, read.drift);
      } catch (e) {
        if (e instanceof NormalizeError) return abstain(e.reason, e.message, evidence, read.drift);
        throw e;
      }
    }
    case 'url': {
      const ok = matchUrl(a.match, ctx.snapshot.page.url);
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
      if (!lo)
        return fail(`${hits.length} request(s) match ${desc} (expected ${describeNumberCompare(count)})`, evidence);
      return pass(`${hits.length} request(s) match ${desc}`, evidence);
    }
    case 'allOf':
    case 'anyOf': {
      const subs = a.of.map((s) => evaluateAssertion(ctx, s));
      const status = a.kind === 'allOf' ? kleeneAnd(subs.map((s) => s.status)) : kleeneOr(subs.map((s) => s.status));
      const relevant = subs.filter((s) => s.status === status);
      const evidence = (status === 'abstain' ? subs : relevant).flatMap((s) => s.evidence);
      const drift = subs.flatMap((s) => s.drift);
      const message = `${a.kind}: ${subs.map((s) => `[${s.status}] ${s.message}`).join(' | ')}`;
      if (status === 'abstain') {
        const reasons = [...new Set(subs.filter((s) => s.status === 'abstain').map((s) => s.reason))];
        return abstain(
          reasons.length === 1 && reasons[0] ? reasons[0] : 'subcheck_abstained',
          message,
          evidence,
          drift,
        );
      }
      return { status, message, evidence, drift };
    }
  }
}

// ---------------------------------------------------------------------------
// Check sets
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** Compute snapshot and check-set digests (default true). Stress testing skips them for speed. */
  digests?: boolean;
}

export function evaluate(checkSet: CheckSet, snapshot: EvidenceSnapshot, opts: EvaluateOptions = {}): Outcome {
  const ctx: Ctx = { snapshot, index: new AXIndex(snapshot.a11y) };

  const checks: CheckResult[] = checkSet.checks.map((c) => {
    let r: AssertionResult;
    try {
      r = evaluateAssertion(ctx, c.assert);
    } catch (e) {
      // Defensive: a check that throws must never decide. Validation should prevent this.
      r = abstain('type_mismatch', `check raised an error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { check: c.id, requirement: c.requirement, description: c.description, ...r };
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
