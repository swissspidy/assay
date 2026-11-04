/**
 * Invalid mutants: near misses derived from a correct snapshot by breaking the
 * evidence a check relies on, guided by what the check compares. A check set
 * must reject every mutant (verdict fail, or at worst abstain). A check that
 * still passes when its own evidence was broken is flagged as weak.
 */
import type {
  Assertion,
  AXNode,
  CheckSet,
  Comparison,
  EvidenceSnapshot,
  Json,
  Locator,
  NumberCompare,
  NetworkEntry,
  Normalizer,
  RequestMatch,
  StorageRecord,
  TextMatch,
  ValueSource,
} from '../types.ts';
import { AXIndex, readNodeField, resolveTarget, type INode } from '../runtime/axindex.ts';
import { matchRequest } from '../runtime/network.ts';
import { compare, compareNumber, jsonPointer } from '../runtime/compare.ts';
import { evaluateAssertion } from '../runtime/evaluate.ts';
import { applyNormalizers, fromJson, toJson, type TypedValue } from '../runtime/values.ts';
import { stripGlobal } from '../text.ts';
import { clone, editById, nearMiss, replaceText, setPointer, treeChanged } from './edit.ts';
import { exampleOf, schemaViolations } from './schema.ts';
import { renderLike, violations } from './violate.ts';

export { schemaViolations } from './schema.ts';

export interface Mutant {
  id: string;
  /** Check whose evidence this mutant breaks (undefined for set-level mutants). */
  check?: string;
  description: string;
  snapshot: EvidenceSnapshot;
  /** Advisory mutants report a risk rather than a definite defect (see claims-only). */
  advisory?: boolean;
}

type M = Omit<Mutant, 'check'>;

const key = (v: TypedValue) => JSON.stringify(v);

function exampleFor(m: TextMatch | undefined): string | undefined {
  if (m === undefined) return undefined;
  if (typeof m === 'string') return m;
  if ('equals' in m) return m.equals;
  if ('contains' in m) return m.contains;
  return undefined;
}

function textMatchComparison(m: TextMatch): Comparison {
  if (typeof m === 'string') return { equals: m };
  if ('equals' in m) {
    return m.ignoreCase
      ? { regex: `^${m.equals.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, flags: 'i' }
      : { equals: m.equals };
  }
  if ('contains' in m) return { contains: m.contains, ...(m.ignoreCase ? { ignoreCase: true } : {}) };
  return { regex: m.regex, ...(m.flags ? { flags: m.flags } : {}) };
}

/** Build a node matching `loc`, wrapped in nodes for its `within` chain and landmark. */
function synthesize(loc: Locator): AXNode | undefined {
  if (loc.text !== undefined && exampleFor(loc.text) === undefined) return undefined;
  if (loc.name !== undefined && exampleFor(loc.name) === undefined) return undefined;
  const name = exampleFor(loc.name);
  const text = exampleFor(loc.text) ?? name;
  let node: AXNode = {
    role: loc.role,
    ...(name !== undefined ? { name } : {}),
    ...(loc.level !== undefined ? { level: loc.level } : {}),
    ...(text !== undefined ? { children: [{ role: 'text', name: text }] } : {}),
  };
  if (loc.within) {
    const outer = synthesize(loc.within);
    if (!outer) return undefined;
    node = { ...outer, children: [...(outer.children ?? []), node] };
  }
  if (loc.landmark) {
    const lname = exampleFor(loc.landmark.name);
    node = { role: loc.landmark.role, ...(lname !== undefined ? { name: lname } : {}), children: [node] };
  }
  return node;
}

function localeOf(steps: Normalizer[] | undefined): string | undefined {
  for (const s of steps ?? []) if (typeof s === 'object' && 'locale' in s) return s.locale;
  return undefined;
}

export function timezoneOf(steps: Normalizer[] | undefined): string | undefined {
  for (const s of steps ?? []) if (typeof s === 'object' && 'timezone' in s && s.timezone) return s.timezone;
  return undefined;
}

/**
 * The substring of a canonical raw value that the pipeline reads: what is left after the
 * leading steps that only cut text away (extract, a replace that deletes, trim). A label cut
 * off that way ("Estimated delivery: ") is not part of the value, so an edit of the value
 * keeps it. Undefined when the steps do not leave one contiguous part of the raw text.
 */
export function readSpan(raw: string, steps: Normalizer[] | undefined): string | undefined {
  let span = raw;
  for (const step of steps ?? []) {
    if (step === 'trim') span = span.trim();
    else if (typeof step === 'object' && step.op === 'extract') {
      const m = new RegExp(step.regex, stripGlobal(step.flags)).exec(span);
      if (!m) return undefined;
      const g = step.group ?? (m.length > 1 ? 1 : 0);
      const v = typeof g === 'number' ? m[g] : m.groups?.[g];
      if (v === undefined) return undefined;
      span = v;
    } else if (typeof step === 'object' && step.op === 'replace' && step.with === '') {
      span = span.replace(new RegExp(step.regex, step.flags ?? 'g'), '');
    } else break;
  }
  span = span.trim();
  return span && raw.includes(span) ? span : undefined;
}

/** The array in a raw string that the pipeline parses first ("json"), if it is one. */
function jsonArrayText(raw: Json, steps: Normalizer[] | undefined): Json[] | undefined {
  const first = steps?.[0];
  if (typeof raw !== 'string' || !(first === 'json' || (typeof first === 'object' && first.op === 'json')))
    return undefined;
  try {
    const v = JSON.parse(raw) as Json;
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** One item of an array removed, changed (a near miss), or a changed copy added. */
function arrayEdits(arr: Json[]): { what: string; value: Json }[] {
  const out: { what: string; value: Json }[] = [];
  arr.slice(0, 8).forEach((item, i) => {
    out.push({ what: `item ${i} removed`, value: arr.filter((_, j) => j !== i) });
    const changed = nearMiss(item);
    if (changed !== undefined)
      out.push({ what: `item ${i} changed`, value: arr.map((x, j) => (j === i ? changed : x)) });
  });
  const extra = arr.length ? nearMiss(arr[0]!) : undefined;
  if (extra !== undefined) out.push({ what: 'an extra item', value: [...arr, extra] });
  return out;
}

/** Other values at the same position in sibling array elements (for "wrong item" substitutions). */
function siblingValues(doc: Json, pointer: string): Json[] {
  const parts = pointer.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    if (!/^\d+$/.test(parts[i]!)) continue;
    const arr = jsonPointer(doc, parts.slice(0, i).join('/'));
    if (!Array.isArray(arr)) continue;
    const rest = parts.slice(i + 1).join('/');
    return arr
      .map((_, j) => jsonPointer(doc, [...parts.slice(0, i), String(j), ...(rest ? [rest] : [])].join('/')))
      .filter((x, j): x is Json => x !== undefined && j !== Number(parts[i]));
  }
  return [];
}

// --- value sources -------------------------------------------------------------

interface Readable {
  /** The raw value as the evaluator reads it. */
  raw: Json;
  /** Snapshot with the raw value replaced (undefined if the edit is impossible or a no-op). */
  write(next: Json): EvidenceSnapshot | undefined;
  /** Same-kind values elsewhere (wrong-item candidates). */
  siblings: Json[];
  what: string;
}

function readable(s: EvidenceSnapshot, idx: AXIndex, src: ValueSource): Readable | undefined {
  switch (src.from) {
    case 'node': {
      const r = resolveTarget(idx, src.target);
      if (!r.ok) return undefined;
      const raw = readNodeField(idx, r.node, src.field);
      if (raw === undefined) return undefined;
      const id = r.node.id;
      const field = src.field;
      return {
        raw,
        what: `the ${field} of ${idx.path(r.node)}`,
        siblings: idx.all
          .filter((n) => n.node.role === r.node.node.role && n.id !== id)
          .map((n) => readNodeField(idx, n, field))
          .filter((x): x is string => x !== undefined && x !== raw),
        write(next) {
          if (typeof next !== 'string') return undefined;
          const out = editById(s, (n, nid) => {
            if (nid !== id) return undefined;
            if (field === 'url' || field === 'value') return { ...n, [field]: next };
            if (field === 'name' && !n.children) return { ...n, name: next };
            return (
              replaceText(n, raw, next) ?? {
                ...n,
                ...(field === 'name' ? { name: next } : {}),
                children: [{ role: 'text', name: next }],
              }
            );
          });
          return treeChanged(s, out) ? out : undefined;
        },
      };
    }
    case 'text': {
      // Read what the evaluator reads: the scoped subtree's text, or the free page text.
      let hay = s.text.replace(/[^\S\n]+/g, ' ');
      let scopeNode: INode | undefined;
      if (src.scope) {
        const r = resolveTarget(idx, src.scope);
        if (!r.ok) return undefined;
        scopeNode = r.node;
        hay = idx.text(r.node);
      }
      const m = new RegExp(src.pattern, stripGlobal(src.flags)).exec(hay);
      const g = src.group ?? (m && m.length > 1 ? 1 : 0);
      const got = m ? (typeof g === 'number' ? m[g] : m.groups?.[g]) : undefined;
      if (!got) return undefined;
      if (scopeNode) {
        const scope = new Set([scopeNode.id, ...idx.descendants(scopeNode).map((n) => n.id)]);
        return {
          raw: got,
          what: `text of ${idx.path(scopeNode)}`,
          siblings: [],
          write(next) {
            if (typeof next !== 'string') return undefined;
            const out = editById(s, (n, id) =>
              scope.has(id) && (n.role === 'text' || !n.children) && n.name?.includes(got)
                ? { ...n, name: n.name.replace(got, () => next) }
                : undefined,
            );
            if (!treeChanged(s, out)) return undefined;
            return { ...out, text: s.text.replace(got, () => next) };
          },
        };
      }
      return {
        raw: got,
        what: 'page text',
        siblings: [],
        write(next) {
          if (typeof next !== 'string' || !s.text.includes(got)) return undefined;
          return editById({ ...s, text: s.text.replace(got, () => next) }, (n) =>
            n.role === 'text' && n.name?.includes(got) ? { ...n, name: n.name.replace(got, () => next) } : undefined,
          );
        },
      };
    }
    case 'url': {
      let u: URL;
      try {
        u = new URL(s.page.url);
      } catch {
        return undefined;
      }
      const part = src.part;
      const raw = typeof part === 'object' ? u.searchParams.get(part.param) : part === 'pathname' ? u.pathname : null;
      if (raw === null) return undefined;
      return {
        raw,
        what: `URL ${typeof part === 'object' ? part.param : part}`,
        siblings: [],
        write(next) {
          if (typeof next !== 'string') return undefined;
          const v = new URL(s.page.url);
          if (typeof part === 'object') v.searchParams.set(part.param, next);
          else v.pathname = next;
          return { ...s, page: { ...s.page, url: v.toString() } };
        },
      };
    }
    case 'storage': {
      const before = src.at === 'before';
      const st = before ? s.baseline?.storage : s.storage;
      if (!st) return undefined;
      // Writes the edited storage back where it was read from.
      const put = (storage: StorageRecord): EvidenceSnapshot =>
        before ? { ...s, baseline: { ...s.baseline!, storage } } : { ...s, storage };
      const when = before ? ' before the task' : '';
      if (src.area === 'cookie') {
        const c = st.cookies.find((x) => x.name === src.key);
        if (!c || typeof c.value !== 'string') return undefined;
        return {
          raw: c.value,
          what: `cookie ${src.key}${when}`,
          siblings: [],
          write(next) {
            if (typeof next !== 'string') return undefined;
            return put({ ...st, cookies: st.cookies.map((x) => (x.name === src.key ? { ...x, value: next } : x)) });
          },
        };
      }
      let origin: string;
      try {
        origin = src.origin ? new URL(src.origin).origin : new URL(s.page.url).origin;
      } catch {
        return undefined;
      }
      const which: 'local' | 'session' = src.area;
      const area = st[which][origin];
      const raw = area?.[src.key];
      // Absent, or redacted at capture (nothing to perturb).
      if (typeof raw !== 'string') return undefined;
      return {
        raw,
        what: `${which}Storage ${src.key}${when}`,
        siblings: [],
        write(next) {
          if (typeof next !== 'string') return undefined;
          return put({ ...st, [which]: { ...st[which], [origin]: { ...area, [src.key]: next } } });
        },
      };
    }
    case 'request':
    case 'response': {
      const hits = (s.network ?? []).filter((e) => matchRequest(src.match, e) === 'yes');
      if (!hits.length) return undefined;
      const target = (src.pick ?? 'only') === 'last' ? hits.at(-1)! : hits[0]!;
      const which = src.from === 'request' ? 'requestBody' : 'responseBody';
      const body = target[which];
      if (body === undefined) return undefined;
      const pointer = src.pointer ?? '';
      const raw = jsonPointer(body, pointer);
      if (raw === undefined) return undefined;
      return {
        raw,
        what: `${src.from} body${pointer ? ` at ${pointer}` : ''} of #${target.seq}`,
        siblings: pointer ? siblingValues(body, pointer) : [],
        write(next) {
          const network = clone(s.network!);
          const e = network.find((x) => x.seq === target.seq)!;
          if (pointer === '') e[which] = next;
          else if (!setPointer(e[which]!, pointer, next)) return undefined;
          return { ...s, network };
        },
      };
    }
    case 'probe': {
      const before = src.at === 'before';
      const probes = before ? s.baseline?.probes : s.probes;
      const p = probes?.[src.probe];
      if (!probes || !p?.ok) return undefined;
      const pointer = src.pointer ?? '';
      const raw = jsonPointer(p.value, pointer);
      if (raw === undefined) return undefined;
      return {
        raw,
        what: `probe ${src.probe}${before ? ' before the task' : ''}${pointer ? ` at ${pointer}` : ''}`,
        siblings: pointer ? siblingValues(p.value, pointer) : [],
        write(next) {
          let value: Json = next;
          if (pointer !== '') {
            value = clone(p.value);
            if (!setPointer(value, pointer, next)) return undefined;
          }
          const edited = { ...probes, [src.probe]: { ok: true as const, value } };
          return before ? { ...s, baseline: { ...s.baseline!, probes: edited } } : { ...s, probes: edited };
        },
      };
    }
  }
}

function valueMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'value' }>): M[] {
  const r = readable(s, idx, a.source);
  if (!r) return [];
  let typed: TypedValue;
  try {
    typed = applyNormalizers(fromJson(r.raw), a.normalize);
  } catch {
    return [];
  }
  const out: M[] = [];
  const seen = new Set<string>();
  const add = (next: Json, why: string) => {
    const k = JSON.stringify(next);
    if (seen.has(k)) return;
    const snap = r.write(next);
    if (!snap) return;
    seen.add(k);
    out.push({
      id: `value:${out.length}`,
      description: `${r.what} is ${JSON.stringify(next)} (${why})`,
      snapshot: snap,
    });
  };
  const textual = typeof r.raw === 'string';
  const span = textual ? readSpan(r.raw as string, a.normalize) : undefined;
  for (const { value: cand, lenientProbe } of violations(typed, a.expect)) {
    let next: Json | undefined;
    if (textual) {
      if (span === undefined) continue;
      const rendered = renderLike(span, typed, cand, localeOf(a.normalize), timezoneOf(a.normalize));
      if (rendered === undefined) continue;
      next = (r.raw as string).replace(span, () => rendered);
    } else {
      // A JSON value is written as the candidate itself; the read-back below drops it
      // unless the normalizers turn it back into exactly the candidate.
      next = cand.type === 'money' ? { ...cand.value } : (cand.value as Json);
    }
    // The pipeline must read back exactly the intended near miss.
    try {
      if (key(applyNormalizers(fromJson(next), a.normalize)) !== key(cand)) continue;
    } catch {
      continue;
    }
    add(next, lenientProbe ? 'a near miss of the expected value' : 'violates the comparison');
  }
  // Wrong item: the value of a sibling (another row, another array element).
  for (const sib of r.siblings.slice(0, 8)) {
    try {
      if (key(applyNormalizers(fromJson(sib), a.normalize)) === key(typed)) continue;
    } catch {
      continue;
    }
    add(sib, 'a different item’s value');
  }
  // A JSON array (a cart, an order's items): one item removed, changed or added. Kept
  // only when the check's own normalizers and comparison read it as a violation.
  // JSON text holding an array (a cart in localStorage) read through "json": the same
  // edits, written back as JSON text.
  const parsed = jsonArrayText(r.raw, a.normalize);
  const arr = Array.isArray(r.raw) ? r.raw : parsed;
  if (arr) {
    for (const edit of arrayEdits(arr)) {
      const next: Json = parsed ? JSON.stringify(edit.value) : edit.value;
      try {
        if (compare(applyNormalizers(fromJson(next), a.normalize), a.expect).ok) continue;
      } catch {
        continue;
      }
      add(next, edit.what);
    }
  }
  const src = a.source;
  const before = src.from === 'storage' && src.at === 'before';
  const st = src.from === 'storage' ? (before ? s.baseline?.storage : s.storage) : undefined;
  if (src.from === 'storage' && st) {
    const put = (storage: StorageRecord): EvidenceSnapshot =>
      before ? { ...s, baseline: { ...s.baseline!, storage } } : { ...s, storage };
    let unset: EvidenceSnapshot | undefined;
    if (src.area === 'cookie') unset = put({ ...st, cookies: st.cookies.filter((x) => x.name !== src.key) });
    else {
      const which: 'local' | 'session' = src.area;
      try {
        const origin = src.origin ? new URL(src.origin).origin : new URL(s.page.url).origin;
        const { [src.key]: _gone, ...rest } = st[which][origin] ?? {};
        unset = put({ ...st, [which]: { ...st[which], [origin]: rest } });
      } catch {
        unset = undefined;
      }
    }
    if (unset)
      out.push({
        id: 'storage:unset',
        description: `${src.area} ${src.key} is not set${before ? ' before the task' : ''}`,
        snapshot: unset,
      });
  }
  return out;
}

/**
 * A `sameAs` binding: each side in turn is perturbed so that it no longer equals the
 * other (near misses, another item's value, an unset key), as an `equals` against the
 * other side's current value would be.
 */
function bindingMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'value' }>): M[] {
  if (!('sameAs' in a.expect)) return [];
  const other = a.expect.sameAs;
  const read = (src: ValueSource, steps: Normalizer[] | undefined): TypedValue | undefined => {
    const r = readable(s, idx, src);
    if (!r) return undefined;
    try {
      return applyNormalizers(fromJson(r.raw), steps);
    } catch {
      return undefined;
    }
  };
  const left = read(a.source, a.normalize);
  const right = read(other.source, other.normalize);
  if (!left || !right) return [];
  return [
    ...valueMutants(s, idx, {
      kind: 'value',
      source: a.source,
      normalize: a.normalize,
      expect: { equals: toJson(right) },
    }),
    ...valueMutants(s, idx, {
      kind: 'value',
      source: other.source,
      normalize: other.normalize,
      expect: { equals: toJson(left) },
    }).map((m) => ({ ...m, id: `sameAs:${m.id}` })),
  ];
}

/**
 * A binding between the state before and after the task on the same probe value or
 * storage key ("the cart after is the cart before minus the Red Mug"): the run changed
 * nothing, so the value after is the baseline's. Only the value the check reads is
 * compared and replaced; the mutant is dropped when the correct run did not change it
 * (then doing nothing is a correct outcome, as for "keep X unchanged").
 */
function noOpMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'value' }>): M[] {
  if (!('sameAs' in a.expect) || !s.baseline) return [];
  const sides = [a.source, a.expect.sameAs.source];
  const after = sides.find((x) => (x.from === 'probe' || x.from === 'storage') && x.at !== 'before');
  const before = sides.find((x) => (x.from === 'probe' || x.from === 'storage') && x.at === 'before');
  if (!after || !before) return [];
  const same =
    after.from === 'probe' && before.from === 'probe'
      ? after.probe === before.probe && (after.pointer ?? '') === (before.pointer ?? '')
      : after.from === 'storage' && before.from === 'storage'
        ? after.area === before.area && after.key === before.key && after.origin === before.origin
        : false;
  if (!same) return [];
  const now = readable(s, idx, after);
  const was = readable(s, idx, before);
  if (!now || !was || JSON.stringify(now.raw) === JSON.stringify(was.raw)) return [];
  const snap = now.write(clone(was.raw));
  return snap
    ? [{ id: 'baseline:no-op', description: `${now.what} is what it was before the task`, snapshot: snap }]
    : [];
}

// --- requests ------------------------------------------------------------------

/** The effective integer bounds of a count: the strongest of eq/gte/gt and eq/lte/lt. */
function countBounds(count: NumberCompare): { lower?: number; upper?: number } {
  if (count.eq !== undefined) return { lower: count.eq, upper: count.eq };
  // Counts are integers, so fractional bounds round inward (lt: 2.5 allows at most 2).
  const lows = [
    count.gte !== undefined ? Math.ceil(count.gte) : undefined,
    count.gt !== undefined ? Math.floor(count.gt) + 1 : undefined,
  ].filter((x) => x !== undefined);
  const highs = [
    count.lte !== undefined ? Math.floor(count.lte) : undefined,
    count.lt !== undefined ? Math.ceil(count.lt) - 1 : undefined,
  ].filter((x) => x !== undefined);
  return {
    ...(lows.length ? { lower: Math.max(...lows) } : {}),
    ...(highs.length ? { upper: Math.min(...highs) } : {}),
  };
}

function exampleUrl(s: EvidenceSnapshot, m: RequestMatch): string {
  let origin = 'http://localhost';
  try {
    origin = new URL(m.url?.origin ?? s.page.url).origin;
  } catch {
    /* keep default */
  }
  const path = (m.url?.path ?? '/').replace(/\/\*\*$/, '').replace(/:[^/]+|\*/g, 'x') || '/';
  return origin + path;
}

function synthesizeRequest(s: EvidenceSnapshot, m: RequestMatch, seq: number): NetworkEntry {
  const method = Array.isArray(m.method) ? m.method[0]! : (m.method ?? 'POST');
  const bound = typeof m.status === 'number' ? { eq: m.status } : m.status;
  const options = bound
    ? [
        bound.eq,
        bound.gte,
        bound.gt !== undefined ? bound.gt + 1 : undefined,
        200,
        bound.lte,
        bound.lt !== undefined ? bound.lt - 1 : undefined,
      ]
    : [];
  const status = bound ? (options.find((x) => x !== undefined && compareNumber(x, bound)) ?? 200) : 200;
  const reqBody = exampleOf(m.requestBody);
  const respBody = exampleOf(m.responseBody);
  return {
    seq,
    method,
    url: exampleUrl(s, m),
    resourceType: 'fetch',
    status,
    requestHeaders: { 'content-type': 'application/json' },
    ...(reqBody !== undefined ? { requestBody: reqBody } : {}),
    responseHeaders: { 'content-type': 'application/json' },
    ...(respBody !== undefined ? { responseBody: respBody } : {}),
  };
}

function bodyViolations(
  s: EvidenceSnapshot,
  seqs: number[],
  which: 'requestBody' | 'responseBody',
  schema: unknown,
): M[] {
  const first = s.network?.find((e) => seqs.includes(e.seq) && e[which] !== undefined);
  if (!first) return [];
  return schemaViolations(schema, first[which]!).map((v, i) => ({
    id: `${which}:schema:${i}`,
    description: `${which}: ${v.what}`,
    snapshot: {
      ...s,
      network: s.network!.map((e) =>
        seqs.includes(e.seq) && e[which] !== undefined ? { ...e, [which]: clone(v.value) } : e,
      ),
    },
  }));
}

function requestMutants(s: EvidenceSnapshot, a: Extract<Assertion, { kind: 'request' }>): M[] {
  if (!s.network) return [];
  const net = s.network;
  const hits = net.filter((e) => matchRequest(a.match, e) === 'yes').map((e) => e.seq);
  const count = a.count ?? { gte: 1 };
  const nextSeq = Math.max(-1, ...net.map((e) => e.seq)) + 1;
  const { lower, upper } = countBounds(count);
  const out: M[] = [];
  if (upper !== undefined) {
    // Enough extra requests to exceed the upper bound.
    const n = Math.max(1, upper + 1 - hits.length);
    const proto = hits.length ? net.find((e) => e.seq === hits[0])! : synthesizeRequest(s, a.match, nextSeq);
    const extras = Array.from({ length: n }, (_, i) => ({ ...clone(proto), seq: nextSeq + i }));
    const times = n > 1 ? ` ${hits.length + n} times` : hits.length ? ' twice' : '';
    // A synthesized request the matcher does not accept (e.g. a required query) is no near miss.
    if (matchRequest(a.match, proto) === 'yes')
      out.push({
        id: 'request:extra',
        description: hits.length
          ? `the request was sent${times}`
          : `a forbidden ${proto.method} ${proto.url} was sent${times}`,
        snapshot: { ...s, network: [...net, ...extras] },
      });
  }
  // Removing or breaking matches only violates a lower bound.
  if (hits.length && lower !== undefined && lower > 0) {
    out.push({
      id: 'request:missing',
      description: 'the request was never sent',
      snapshot: { ...s, network: net.filter((e) => !hits.includes(e.seq)) },
    });
    out.push({
      id: 'request:failed',
      description: 'the request failed with HTTP 500',
      snapshot: {
        ...s,
        network: net.map((e) =>
          hits.includes(e.seq) ? { ...clone(e), status: 500, responseBody: { error: 'Internal Server Error' } } : e,
        ),
      },
    });
    if (hits.length > 1 && lower > 1) {
      out.push({
        id: 'request:one-fewer',
        description: 'one of the requests is missing',
        snapshot: { ...s, network: net.filter((e) => e.seq !== hits.at(-1)) },
      });
    }
    for (const [which, schema] of [
      ['requestBody', a.match.requestBody],
      ['responseBody', a.match.responseBody],
    ] as const) {
      if (schema !== undefined)
        out.push(...bodyViolations(s, hits, which, schema).map((m) => ({ ...m, id: `request:${m.id}` })));
    }
  }
  return out;
}

// --- a11y ----------------------------------------------------------------------

function stateMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'state' }>): M[] {
  const r = resolveTarget(idx, a.target);
  if (!r.ok) return [];
  const target = r.node;
  const out: M[] = [];
  const flipped: Record<string, boolean> = {};
  for (const k of ['checked', 'pressed', 'selected', 'expanded', 'disabled'] as const) {
    const want = a.expect[k];
    if (want === undefined) continue;
    const to = want !== true;
    flipped[k] = to;
    out.push({
      id: `state:${k}`,
      description: `${k} is ${to} instead of ${String(want)}`,
      snapshot: editById(s, (n, id) => (id === target.id ? { ...n, states: { ...n.states, [k]: to } } : undefined)),
    });
  }
  // Wrong item: the state is set on a different node of the same role instead.
  const other = idx.all.find((n) => n.node.role === target.node.role && n.id !== target.id);
  if (other && Object.keys(flipped).length) {
    const wanted = Object.fromEntries(Object.keys(flipped).map((k) => [k, a.expect[k as keyof typeof a.expect]]));
    out.push({
      id: 'state:wrong-target',
      description: `the state is set on ${idx.path(other)} instead`,
      snapshot: editById(s, (n, id) =>
        id === target.id
          ? { ...n, states: { ...n.states, ...flipped } }
          : id === other.id
            ? { ...n, states: { ...n.states, ...wanted } }
            : undefined,
      ),
    });
  }
  for (const k of ['name', 'value', 'text'] as const) {
    const m = a.expect[k];
    if (m === undefined) continue;
    const cur = readNodeField(idx, target, k);
    if (cur === undefined) continue;
    for (const { value } of violations({ type: 'string', value: cur }, textMatchComparison(m))) {
      if (value.type !== 'string') continue;
      const next = value.value;
      const snap = editById(s, (n, id) => {
        if (id !== target.id) return undefined;
        if (k === 'value') return { ...n, value: next };
        if (k === 'name') return { ...n, name: next };
        return { ...n, children: [{ role: 'text', name: next }] };
      });
      if (treeChanged(s, snap)) {
        out.push({ id: `state:${k}`, description: `${k} is ${JSON.stringify(next)}`, snapshot: snap });
        break;
      }
    }
  }
  if (a.expect.level !== undefined) {
    out.push({
      id: 'state:level',
      description: 'heading level changed',
      snapshot: editById(s, (n, id) => (id === target.id ? { ...n, level: (a.expect.level! % 6) + 1 } : undefined)),
    });
  }
  return out;
}

function containsMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'contains' }>): M[] {
  let scope: INode = idx.root;
  if (a.scope) {
    const r = resolveTarget(idx, a.scope);
    if (!r.ok) return [];
    scope = r.node;
  }
  const hits = idx.find(a.match, scope);
  const ids = new Set(hits.map((n) => n.id));
  const count = a.count ?? { gte: 1 };
  const { lower, upper } = countBounds(count);
  const out: M[] = [];
  if (lower !== undefined && lower > 0 && hits.length) {
    out.push({
      id: 'contains:removed',
      description: `the matching item(s) are missing (${hits.length} removed)`,
      snapshot: editById(s, (n, id) => (ids.has(id) ? null : undefined)),
    });
    if (hits.length > 1 || lower > 1) {
      const last = hits.at(-1)!.id;
      out.push({
        id: 'contains:one-fewer',
        description: 'one matching item is missing (partial completion)',
        snapshot: editById(s, (n, id) => (id === last ? null : undefined)),
      });
    }
    // Wrong item: the matching item is replaced by a sibling of the same role that does not match.
    const sib = idx.descendants(scope).find((n) => n.node.role === a.match.role && !ids.has(n.id) && n.node.name);
    if (sib) {
      const first = hits[0]!.id;
      const swapped = editById(s, (n, id) => (id === first ? clone(sib.node) : undefined));
      if (treeChanged(s, swapped)) {
        out.push({
          id: 'contains:wrong-item',
          description: `${sib.node.role} ${JSON.stringify(sib.node.name)} is there instead`,
          snapshot: swapped,
        });
      }
    }
  }
  if (upper !== undefined) {
    const extra = Math.max(1, upper + 1 - hits.length);
    // A match inside the scope is copied next to itself, so it keeps its within/landmark
    // ancestors. Otherwise a sample is inserted under the scope; a bare copy of a match
    // found elsewhere would lose that context, so such locators are synthesized with it.
    const first = hits[0];
    const context = a.match.within !== undefined || a.match.landmark !== undefined;
    const sample =
      first?.node ?? (context ? undefined : idx.all.find((n) => idx.matches(n, a.match))?.node) ?? synthesize(a.match);
    if (sample) {
      const copies = () => Array.from({ length: extra }, () => clone(sample));
      const scopeId = scope.id;
      const snap = first
        ? editById(s, (n, id) => (id === first.id ? [n, ...copies()] : undefined))
        : editById(s, (n, id) =>
            id === scopeId ? { ...n, children: [...(n.children ?? []), ...copies()] } : undefined,
          );
      if (treeChanged(s, snap) && noneHolds(snap, [a])) {
        out.push({
          id: 'contains:extra',
          description:
            upper === 0
              ? `an item that should be absent (${sample.role} ${JSON.stringify(sample.name ?? '')}) is present`
              : 'there are more matching items than allowed',
          snapshot: snap,
        });
      }
    }
  }
  return out;
}

/** No assertion in `subs` passes on `s`. */
function noneHolds(s: EvidenceSnapshot, subs: Assertion[]): boolean {
  const ctx = { snapshot: s, index: new AXIndex(s.a11y) };
  return subs.every((sub) => {
    try {
      return evaluateAssertion(ctx, sub).status !== 'pass';
    } catch {
      return true; // evaluate() turns a throwing check into an abstention
    }
  });
}

function assertionMutants(s: EvidenceSnapshot, idx: AXIndex, a: Assertion): M[] {
  switch (a.kind) {
    case 'state':
      return stateMutants(s, idx, a);
    case 'contains':
      return containsMutants(s, idx, a);
    case 'value':
      return 'sameAs' in a.expect ? [...bindingMutants(s, idx, a), ...noOpMutants(s, idx, a)] : valueMutants(s, idx, a);
    case 'url': {
      let u: URL;
      try {
        u = new URL(s.page.url);
      } catch {
        return [];
      }
      const away = [`${u.origin}/elsewhere`, `${u.origin}/`].find((x) => x !== u.href)!;
      const out: M[] = [
        {
          id: 'url:elsewhere',
          description: 'the browser ended on a different page',
          snapshot: { ...s, page: { ...s.page, url: away } },
        },
      ];
      for (const [k, v] of Object.entries(a.match.query ?? {})) {
        const q = new URL(s.page.url);
        if (v === null) q.searchParams.set(k, 'x');
        else q.searchParams.set(k, String(nearMiss(q.searchParams.get(k) ?? '') ?? 'x'));
        out.push({
          id: `url:query:${k}`,
          description: `query parameter ${k} differs`,
          snapshot: { ...s, page: { ...s.page, url: q.toString() } },
        });
      }
      return out;
    }
    case 'request':
      return requestMutants(s, a);
    case 'allOf':
      return a.of.flatMap((sub, i) => assertionMutants(s, idx, sub).map((m) => ({ ...m, id: `allOf[${i}]:${m.id}` })));
    case 'anyOf': {
      // Only breaking every alternative at once is a definite near miss. Each step
      // must keep the alternatives broken so far broken (they may share evidence).
      let snap = s;
      const parts: string[] = [];
      for (const [i, sub] of a.of.entries()) {
        if (noneHolds(snap, [sub])) continue;
        const next = assertionMutants(snap, new AXIndex(snap.a11y), sub).find((m) =>
          noneHolds(m.snapshot, a.of.slice(0, i + 1)),
        );
        if (!next) return [];
        snap = next.snapshot;
        parts.push(next.description);
      }
      return [{ id: 'anyOf:all', description: `every alternative broken: ${parts.join('; ')}`, snapshot: snap }];
    }
  }
}

/** The page still claims success, but nothing structured happened. */
function claimsOnly(s: EvidenceSnapshot): Mutant {
  return {
    id: 'claims-only',
    description:
      'the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable',
    snapshot: {
      ...s,
      network: s.network ? s.network.filter((e) => e.method === 'GET') : null,
      storage: s.storage ? { cookies: [], local: {}, session: {} } : null,
      probes: Object.fromEntries(Object.keys(s.probes).map((k) => [k, { ok: false as const, error: 'not reachable' }])),
    },
    advisory: true,
  };
}

const CLAIM_TEXT = 'Success! Your request has been completed.';

/** Adds a success claim to a mutant; it must not turn a rejection into success. */
export function withSuccessClaim(m: Mutant): Mutant {
  const claim: AXNode = { role: 'status', children: [{ role: 'text', name: CLAIM_TEXT }] };
  let placed = false;
  let snap = editById(m.snapshot, (n) => {
    if (n.role !== 'main' || placed) return undefined;
    placed = true;
    return { ...n, children: [clone(claim), ...(n.children ?? [])] };
  });
  if (!placed) snap = { ...snap, a11y: { ...snap.a11y, children: [clone(claim), ...(snap.a11y.children ?? [])] } };
  return {
    ...m,
    id: `${m.id}+claim`,
    description: `${m.description}, while the page announces success`,
    snapshot: { ...snap, text: `${CLAIM_TEXT}\n${snap.text}` },
  };
}

export function generateMutants(cs: CheckSet, s: EvidenceSnapshot): Mutant[] {
  const idx = new AXIndex(s.a11y);
  const out: Mutant[] = [];
  for (const c of cs.checks) {
    for (const m of assertionMutants(s, idx, c.assert)) out.push({ ...m, id: `${c.id}:${m.id}`, check: c.id });
  }
  out.push(claimsOnly(s));
  return out;
}
