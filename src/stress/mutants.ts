/**
 * Invalid mutants: near misses derived from a correct snapshot by breaking the
 * evidence a check relies on, guided by what the check compares. A check set
 * must reject every mutant (verdict fail, or at worst abstain). A check that
 * still passes when its own evidence was broken is flagged as weak.
 */
import type {
  Assertion,
  AssertionResult,
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
  Target,
  TextMatch,
  ValueSource,
} from '../types.ts';
import { AXIndex, readNodeField, resolveTarget, type INode } from '../runtime/axindex.ts';
import { matchPage, matchRequest } from '../runtime/network.ts';
import { compare, compareNumber, jsonPointer } from '../runtime/compare.ts';
import { evaluateAssertion, openPages } from '../runtime/evaluate.ts';
import { applyNormalizers, fromJson, toJson, type TypedValue } from '../runtime/values.ts';
import { canonical, stripGlobal } from '../text.ts';
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
  // A cell's column comes from the table's header row, which a lone node cannot carry.
  if (loc.column !== undefined) return undefined;
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
function arrayEdits(arr: Json[]): { what: string; value: Json; pairing?: boolean }[] {
  const out: { what: string; value: Json; pairing?: boolean }[] = [];
  arr.slice(0, 8).forEach((item, i) => {
    out.push({ what: `item ${i} removed`, value: arr.filter((_, j) => j !== i) });
    const changed = nearMiss(item);
    if (changed !== undefined)
      out.push({ what: `item ${i} changed`, value: arr.map((x, j) => (j === i ? changed : x)) });
  });
  const extra = arr.length ? nearMiss(arr[0]!) : undefined;
  if (extra !== undefined) out.push({ what: 'an extra item', value: [...arr, extra] });
  out.push(...pairingSwaps(arr).map((x) => ({ ...x, pairing: true })));
  return out;
}

/** Pairing swaps kept per value, after the check's own comparison filtered them. */
const MAX_PAIRING_SWAPS = 3;

const isRecord = (x: Json | undefined): x is { [key: string]: Json } =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Two records swap one field (quantities, prices): every field taken on its own still holds
 * the same values, only which record has which value changed. A comparison that sorts each
 * field separately cannot see it; one that keeps the fields of a record together can.
 */
function pairingSwaps(arr: Json[]): { what: string; value: Json }[] {
  const out: { what: string; value: Json }[] = [];
  const keys = [...new Set(arr.slice(0, 8).flatMap((x) => (isRecord(x) ? Object.keys(x) : [])))];
  for (const k of keys) {
    const pair = arr.slice(0, 8).flatMap((x, i) =>
      arr.slice(i + 1, 8).flatMap((y, d) => {
        if (!isRecord(x) || !isRecord(y) || !(k in x) || !(k in y)) return [];
        return JSON.stringify(x[k]) !== JSON.stringify(y[k]) ? [[i, i + 1 + d] as const] : [];
      }),
    )[0];
    if (!pair) continue;
    const [i, j] = pair;
    const a = arr[i] as { [key: string]: Json };
    const b = arr[j] as { [key: string]: Json };
    const value = arr.map((x, n) => (n === i ? { ...a, [k]: b[k]! } : n === j ? { ...b, [k]: a[k]! } : x));
    out.push({ what: `items ${i} and ${j} swap their ${k}`, value });
  }
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

/** `rec`: inside an `each`, the record that locators and text sources resolve within. */
function readable(s: EvidenceSnapshot, idx: AXIndex, src: ValueSource, rec?: INode): Readable | undefined {
  switch (src.from) {
    case 'node': {
      const r = resolveTarget(idx, src.target, rec);
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
      // Inside a record, an unscoped text source reads the record's text.
      let scopeNode: INode | undefined = rec;
      if (src.scope) {
        const r = resolveTarget(idx, src.scope, rec);
        if (!r.ok) return undefined;
        scopeNode = r.node;
      }
      // Scoped and record text is canonicalized, as the evaluator reads it (ADR 0001 §2.3).
      if (scopeNode) hay = canonical(idx.text(scopeNode));
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
            // A run whose raw name holds the value with other whitespace (a no-break space)
            // is matched, and rewritten, in its canonical form.
            const out = editById(s, (n, id) => {
              if (!scope.has(id) || (n.role !== 'text' && n.children) || n.name === undefined) return undefined;
              if (n.name.includes(got)) return { ...n, name: n.name.replace(got, () => next) };
              const c = canonical(n.name);
              return c.includes(got) ? { ...n, name: c.replace(got, () => next) } : undefined;
            });
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

function valueMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'value' }>, rec?: INode): M[] {
  const r = readable(s, idx, a.source, rec);
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
    let pairings = 0;
    for (const edit of arrayEdits(arr)) {
      if (edit.pairing && pairings >= MAX_PAIRING_SWAPS) continue;
      const next: Json = parsed ? JSON.stringify(edit.value) : edit.value;
      try {
        if (compare(applyNormalizers(fromJson(next), a.normalize), a.expect).ok) continue;
      } catch {
        continue;
      }
      if (edit.pairing) pairings++;
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
function bindingMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'value' }>, rec?: INode): M[] {
  if (!('sameAs' in a.expect)) return [];
  const other = a.expect.sameAs;
  const read = (src: ValueSource, steps: Normalizer[] | undefined): TypedValue | undefined => {
    const r = readable(s, idx, src, rec);
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
    ...valueMutants(
      s,
      idx,
      { kind: 'value', source: a.source, normalize: a.normalize, expect: { equals: toJson(right) } },
      rec,
    ),
    ...valueMutants(
      s,
      idx,
      { kind: 'value', source: other.source, normalize: other.normalize, expect: { equals: toJson(left) } },
      rec,
    ).map((m) => ({ ...m, id: `sameAs:${m.id}` })),
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
  // What the check reads after its normalizers: a check on the part the task keeps (a post's
  // other tags) reads the same from the correct run and the no-op, and doing nothing is then
  // a correct outcome for it.
  const steps = after === a.source ? a.normalize : a.expect.sameAs.normalize;
  const read = (raw: Json) => {
    try {
      return JSON.stringify(toJson(applyNormalizers(fromJson(raw), steps)));
    } catch {
      return undefined;
    }
  };
  const normalized = read(now.raw);
  if (normalized !== undefined && normalized === read(was.raw)) return [];
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

function stateMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'state' }>, rec?: INode): M[] {
  const r = resolveTarget(idx, a.target, rec);
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

function containsMutants(
  s: EvidenceSnapshot,
  idx: AXIndex,
  a: Extract<Assertion, { kind: 'contains' }>,
  rec?: INode,
): M[] {
  let scope: INode = rec ?? idx.root;
  if (a.scope) {
    const r = resolveTarget(idx, a.scope, rec);
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
    // Wrong column: the matched cell's content trades places with another cell of its row,
    // so the value is still in the row, under another header.
    if (a.match.column !== undefined) {
      const hit = hits[0]!;
      const header = idx.columnHeader(hit);
      const other = hit.parent?.children.find(
        (c) =>
          c !== hit &&
          idx.columnHeader(c) !== undefined &&
          idx.columnHeader(c) !== header &&
          JSON.stringify(c.node) !== JSON.stringify(hit.node),
      );
      if (other) {
        const snap = rebuild(
          s,
          idx,
          new Map([
            [hit.id, { ...other.node, role: hit.node.role }],
            [other.id, { ...hit.node, role: other.node.role }],
          ]),
        );
        if (treeChanged(s, snap))
          out.push({
            id: 'contains:other-column',
            description: `${hit.node.role} ${JSON.stringify(hit.node.name ?? '')} is in column ${JSON.stringify(idx.columnHeader(other)!.node.name ?? '')} instead`,
            snapshot: snap,
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
    // A cell bound to a column cannot be inserted on its own: a cell of that column in the
    // scope takes the forbidden content instead (a listed issue shows "Closed" as its status).
    if (!first && a.match.column !== undefined && upper === 0) {
      const { column: _, within: __, landmark: ___, ...bare } = a.match;
      const cell = synthesize(bare);
      const target = idx
        .descendants(scope)
        .find(
          (n) =>
            n.node.role !== 'columnheader' &&
            idx.columnHeader(n) &&
            idx.matches(n, { role: n.node.role, column: a.match.column! }),
        );
      if (cell && target) {
        const snap = rebuild(s, idx, new Map([[target.id, { ...cell, role: target.node.role }]]));
        if (treeChanged(s, snap) && noneHolds(snap, [a], rec))
          out.push({
            id: 'contains:extra',
            description: `a ${target.node.role} in column ${JSON.stringify(idx.columnHeader(target)!.node.name ?? '')} reads ${JSON.stringify(cell.name ?? '')}, which should be absent`,
            snapshot: snap,
          });
      }
      return out;
    }
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
      if (treeChanged(s, snap) && noneHolds(snap, [a], rec)) {
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

// --- records (each) --------------------------------------------------------------

/** The text a node shows, derived as AXIndex.text derives it. */
function textOf(n: AXNode): string {
  if (n.role === 'text') return n.name ?? '';
  if (n.children?.length) return n.children.map(textOf).filter(Boolean).join(' ');
  return n.name ?? '';
}

const hasHeader = (n: AXNode): boolean => n.role === 'columnheader' || (n.children ?? []).some(hasHeader);

/**
 * The snapshot with nodes replaced (by pre-order id) and nodes inserted after others. An
 * ancestor whose name was its derived text (a row named by its cells) gets the new text as
 * its name, so a moved or swapped cell does not leave a stale row name behind.
 */
function rebuild(
  s: EvidenceSnapshot,
  idx: AXIndex,
  replace: Map<number, AXNode>,
  insertAfter: Map<number, AXNode[]> = new Map(),
): EvidenceSnapshot {
  const touched = new Set<number>();
  for (const id of [...replace.keys(), ...insertAfter.keys()])
    for (let a = idx.all[id]?.parent; a; a = a.parent) touched.add(a.id);
  return editById(s, (n, id) => {
    const r = replace.get(id);
    let node = r ? clone(r) : n;
    const orig = idx.all[id]?.node;
    if (!r && touched.has(id) && orig?.name !== undefined && orig.children?.length) {
      if (canonical(orig.name) === canonical(textOf(orig))) {
        const { name: _, ...rest } = n;
        const t = canonical(textOf(n));
        node = t ? { ...rest, name: t } : rest;
      }
    }
    const extra = insertAfter.get(id);
    if (extra) return [node, ...extra.map((x) => clone(x))];
    return node === n ? undefined : node;
  });
}

/** Child indices from the root to `n`. */
function indexPath(n: INode): number[] {
  const out: number[] = [];
  for (let x = n; x.parent; x = x.parent) out.unshift(x.parent.children.indexOf(x));
  return out;
}

/** Whether the record at `rec`'s place in the edited snapshot still matches the each's locator. */
function keepsIdentity(snap: EvidenceSnapshot, rec: INode, match: Locator): boolean {
  const anchor = rec.id < 0 ? rec.children[0]! : rec;
  const idx = new AXIndex(snap.a11y);
  let n: INode | undefined = idx.root;
  for (const i of indexPath(anchor)) n = n?.children[i];
  return !!n && idx.matches(n, match);
}

/** Nodes inside the record `rec` whose content `a` reads (an absence check reads none). */
function readNodes(idx: AXIndex, a: Assertion, rec: INode): INode[] {
  const at = (t: Target): INode[] => {
    const r = resolveTarget(idx, t, rec);
    return r.ok ? [r.node] : [];
  };
  switch (a.kind) {
    case 'state':
      return at(a.target);
    case 'contains': {
      const scope = a.scope ? at(a.scope)[0] : rec;
      return scope ? idx.find(a.match, scope) : [];
    }
    case 'value':
      return [a.source, ...('sameAs' in a.expect ? [a.expect.sameAs.source] : [])].flatMap((src) =>
        src.from === 'node' ? at(src.target) : src.from === 'text' ? (src.scope ? at(src.scope) : [rec]) : [],
      );
    case 'each': {
      const scope = a.scope ? at(a.scope)[0] : rec;
      return scope ? idx.records(a.match, scope).flatMap((r) => readNodes(idx, a.assert, r)) : [];
    }
    case 'allOf':
    case 'anyOf':
      return a.of.flatMap((b) => readNodes(idx, b, rec));
    default:
      return [];
  }
}

/** Other records like `rec`: sibling rows (not header rows), items or articles; the other terms' records. */
function peerRecords(idx: AXIndex, rec: INode): INode[] {
  if (rec.id < 0) {
    const term = rec.children[0]!;
    return (term.parent?.children ?? [])
      .filter((c) => c !== term && c.node.role === 'term')
      .map((t) => idx.termGroup(t));
  }
  return (rec.parent?.children ?? []).filter((c) => c !== rec && c.node.role === rec.node.role && !hasHeader(c.node));
}

/**
 * Near misses that keep every value on the page but move it out of its record: the
 * content the nested assertion reads is swapped with another record's (whose own
 * content does not satisfy the assertion), or blanked in the record and shown right
 * after it instead. A check that reads the value anywhere on the page accepts both.
 */
function recordMutants(
  s: EvidenceSnapshot,
  idx: AXIndex,
  a: Extract<Assertion, { kind: 'each' }>,
  rec: INode,
  records: INode[],
): M[] {
  const members = rec.children;
  const memberOf = (n: INode): number => {
    for (let x: INode | null = n; x; x = x.parent) {
      const i = members.indexOf(x);
      if (i >= 0) return i;
    }
    return -1;
  };
  const read = readNodes(idx, a.assert, rec);
  const blank = (i: number): AXNode => ({ role: members[i]!.node.role });
  // Content that identifies the record (its term, a row's title cell) is not moved.
  const positions = [
    ...new Set(read.flatMap((n) => (n === rec ? members.map((_, i) => i) : [memberOf(n)])).filter((i) => i >= 0)),
  ]
    .toSorted((x, y) => x - y)
    .filter((i) => keepsIdentity(rebuild(s, idx, new Map([[members[i]!.id, blank(i)]])), rec, a.match));
  if (!positions.length) return [];
  const label = idx.path(rec);
  const roles = [...new Set(positions.map((i) => members[i]!.node.role))].join(' and ');
  const out: M[] = [];
  const matched = new Set(records.map((r) => r.id));
  for (const peer of peerRecords(idx, rec)) {
    if (matched.has(peer.id)) continue;
    let status: string;
    try {
      status = evaluateAssertion({ snapshot: s, index: idx, record: peer }, a.assert).status;
    } catch {
      continue;
    }
    if (status === 'pass') continue;
    const swaps = new Map<number, AXNode>();
    for (const i of positions) {
      const x = members[i]!;
      const y = peer.children[i];
      if (!y || x.node.role !== y.node.role || JSON.stringify(x.node) === JSON.stringify(y.node)) continue;
      swaps.set(x.id, y.node);
      swaps.set(y.id, x.node);
    }
    if (!swaps.size) continue;
    const snap = rebuild(s, idx, swaps);
    if (!treeChanged(s, snap) || !keepsIdentity(snap, rec, a.match)) continue;
    out.push({
      id: `record:swap:${out.length}`,
      description: `the ${roles} of ${label} and of ${idx.path(peer)} are swapped`,
      snapshot: snap,
    });
    if (out.length >= 2) break;
  }
  // Shown right after the record: after the row (item, article), or after a term's last definition.
  const after = rec.id < 0 ? members.at(-1)!.id : rec.id;
  const moved: AXNode = { role: 'paragraph', children: positions.map((i) => clone(members[i]!.node)) };
  const snap = rebuild(s, idx, new Map(positions.map((i) => [members[i]!.id, blank(i)])), new Map([[after, [moved]]]));
  if (treeChanged(s, snap) && keepsIdentity(snap, rec, a.match))
    out.push({
      id: 'record:moved',
      description: `the ${roles} of ${label} is empty there and shown after it instead`,
      snapshot: snap,
    });
  return out;
}

/**
 * `each`: the number of records (as for contains: all removed, one fewer, another item in
 * place of the first, an extra one past an upper bound), the nested assertion's mutants
 * inside the first record, and its values moved out of the record (recordMutants).
 */
function eachMutants(s: EvidenceSnapshot, idx: AXIndex, a: Extract<Assertion, { kind: 'each' }>, rec?: INode): M[] {
  let scope = rec ?? idx.root;
  if (a.scope) {
    const r = resolveTarget(idx, a.scope, rec);
    if (!r.ok) return [];
    scope = r.node;
  }
  if (a.witness && idx.find(a.witness, scope).length !== 1) return [];
  const count: Extract<Assertion, { kind: 'contains' }> = {
    kind: 'contains',
    ...(a.scope ? { scope: a.scope } : {}),
    ...(a.witness ? { witness: a.witness } : {}),
    match: a.match,
    count: a.count ?? { gte: 1 },
  };
  const out = containsMutants(s, idx, count, rec).map((m) => ({ ...m, id: m.id.replace(/^contains:/, 'records:') }));
  const records = idx.records(a.match, scope);
  const first = records[0];
  if (!first) return out;
  out.push(...assertionMutants(s, idx, a.assert, first).map((m) => ({ ...m, id: `record:${m.id}` })));
  out.push(...recordMutants(s, idx, a, first, records));
  return out;
}

/**
 * The record `rec` (of the snapshot an edit started from) in the edited tree `idx`. Edits
 * inside a record leave its pre-order id, and its term's, unchanged.
 */
function recordIn(idx: AXIndex, rec: INode | undefined): INode | undefined {
  if (!rec) return undefined;
  const n = idx.all[rec.id < 0 ? -1 - rec.id : rec.id];
  if (!n) return undefined;
  return rec.id < 0 ? idx.termGroup(n) : n;
}

/** No assertion in `subs` passes on `s` (inside the record `rec` of the snapshot `s` was edited from). */
function noneHolds(s: EvidenceSnapshot, subs: Assertion[], rec?: INode): boolean {
  const index = new AXIndex(s.a11y);
  const record = recordIn(index, rec);
  if (rec && !record) return true;
  const ctx = { snapshot: s, index, ...(record ? { record } : {}) };
  return subs.every((sub) => {
    try {
      return evaluateAssertion(ctx, sub).status !== 'pass';
    } catch {
      return true; // evaluate() turns a throwing check into an abstention
    }
  });
}

/** `rec`: inside an `each`, the record the assertion is evaluated in. */
function assertionMutants(s: EvidenceSnapshot, idx: AXIndex, a: Assertion, rec?: INode): M[] {
  switch (a.kind) {
    case 'state':
      return stateMutants(s, idx, a, rec);
    case 'contains':
      return containsMutants(s, idx, a, rec);
    case 'value':
      return 'sameAs' in a.expect
        ? [...bindingMutants(s, idx, a, rec), ...noOpMutants(s, idx, a)]
        : valueMutants(s, idx, a, rec);
    case 'each':
      return eachMutants(s, idx, a, rec);
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
    case 'page':
      return pageMutants(s, a);
    case 'allOf':
      return a.of.flatMap((sub, i) =>
        assertionMutants(s, idx, sub, rec).map((m) => ({ ...m, id: `allOf[${i}]:${m.id}` })),
      );
    case 'anyOf': {
      // Only breaking every alternative at once is a definite near miss. Each step
      // must keep the alternatives broken so far broken (they may share evidence).
      let snap = s;
      const parts: string[] = [];
      for (const [i, sub] of a.of.entries()) {
        if (noneHolds(snap, [sub], rec)) continue;
        const index = new AXIndex(snap.a11y);
        const here = recordIn(index, rec);
        if (rec && !here) return [];
        const next = assertionMutants(snap, index, sub, here).find((m) =>
          noneHolds(m.snapshot, a.of.slice(0, i + 1), here),
        );
        if (!next) return [];
        snap = next.snapshot;
        parts.push(next.description);
      }
      return [{ id: 'anyOf:all', description: `every alternative broken: ${parts.join('; ')}`, snapshot: snap }];
    }
  }
}

// --- pages and frames (ADR 0012) -------------------------------------------------

/** The snapshot seen from open page `i` (0: the active page), as a `page` assertion reads it. */
function viewOf(s: EvidenceSnapshot, i: number): EvidenceSnapshot {
  if (i === 0) return s;
  const v = s.pages![i - 1]!;
  return { ...s, page: { url: v.url, title: v.title }, a11y: v.a11y, text: v.text };
}

/** `s` with open page `i` replaced by what `view` shows. */
function withView(s: EvidenceSnapshot, i: number, view: EvidenceSnapshot): EvidenceSnapshot {
  if (i === 0) return view;
  const pages = s.pages!.map((p, j) =>
    j === i - 1 ? { ...p, url: view.page.url, title: view.page.title, a11y: view.a11y, text: view.text } : p,
  );
  return { ...s, pages };
}

/**
 * A `page` assertion: the nested assertion's mutants, made on the page it selects; and,
 * for a page other than the active one, that page not being open at all.
 */
function pageMutants(s: EvidenceSnapshot, a: Extract<Assertion, { kind: 'page' }>): M[] {
  const views = openPages(s);
  const hits = views.flatMap((v, i) => (matchPage(a.match, v) ? [i] : []));
  if (hits.length !== 1) return [];
  const i = hits[0]!;
  const view = viewOf(s, i);
  const index = new AXIndex(view.a11y);
  // The selected page's own frames can fail to load too.
  const out: M[] = [...assertionMutants(view, index, a.assert), ...frameMutants(view, index, a.assert)].map((m) => ({
    ...m,
    snapshot: withView(s, i, m.snapshot),
  }));
  if (i > 0) {
    const pages = s.pages!.filter((_, j) => j !== i - 1);
    const { pages: _, ...rest } = s;
    out.push({
      id: 'page:closed',
      description: `the page ${view.page.url} was never opened`,
      snapshot: pages.length ? { ...rest, pages } : rest,
    });
  }
  return out;
}

/** Text runs and leaf names inside a subtree, as they appear in page text. */
function subtreeTexts(n: AXNode): string[] {
  if (n.role === 'text' || !n.children?.length) return n.name ? [n.name] : [];
  return n.children.flatMap(subtreeTexts);
}

/** Frames whose content the snapshot holds, at most this many per check. */
const MAX_FRAME_MUTANTS = 3;

/** An assertion's result, or undefined when it throws (evaluate() would abstain). */
function resultOf(snapshot: EvidenceSnapshot, index: AXIndex, x: Assertion): AssertionResult | undefined {
  try {
    return evaluateAssertion({ snapshot, index }, x);
  } catch {
    return undefined;
  }
}

/** The locators inside an assertion that name the iframe role (targets, scopes, `within` chains). */
function iframeLocators(x: unknown, out: Locator[] = []): Locator[] {
  if (Array.isArray(x)) x.forEach((y) => iframeLocators(y, out));
  else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (o.role === 'iframe') out.push(o as unknown as Locator);
    // A page assertion reads another page's tree: its locators do not address this one.
    if (o.kind !== 'page') for (const v of Object.values(o)) iframeLocators(v, out);
  }
  return out;
}

/**
 * A frame that never loaded: its iframe node is empty (marked unavailable) and its text is
 * gone from the page text. Kept for the checks that read the frame. A part reads it when its
 * result changes, or when one of its locators matches the iframe (an absence check scoped
 * to the frame reads it, though an empty frame leaves its result as it was). As for other
 * mutants, an anyOf reads it only when every alternative does (an alternative that does not
 * still holds), an allOf when some part does. A page assertion reads another page's frames,
 * which its own mutants cover.
 */
function frameMutants(s: EvidenceSnapshot, idx: AXIndex, a: Assertion): M[] {
  const frames = idx.all.filter((n) => n.node.role === 'iframe' && n.node.children?.length);
  if (!frames.length) return [];
  const out: M[] = [];
  for (const f of frames) {
    if (out.length >= MAX_FRAME_MUTANTS) break;
    // Frame text follows the page's, so the last occurrence is the frame's.
    let text = s.text;
    for (const t of subtreeTexts(f.node).toReversed()) {
      const at = text.lastIndexOf(t);
      if (at >= 0) text = text.slice(0, at) + text.slice(at + t.length);
    }
    const snap = editById({ ...s, text }, (n, id) => {
      if (id !== f.id) return undefined;
      const { children: _, ...empty } = n;
      return { ...empty, props: { ...n.props, frame: 'unavailable' } };
    });
    const snapIdx = new AXIndex(snap.a11y);
    const reads = (x: Assertion): boolean => {
      if (x.kind === 'anyOf') return x.of.every(reads);
      if (x.kind === 'allOf') return x.of.some(reads);
      if (x.kind === 'page') return false;
      if (iframeLocators(x).some((loc) => idx.matches(f, loc))) return true;
      const before = resultOf(s, idx, x);
      const after = resultOf(snap, snapIdx, x);
      return !before || !after || after.status !== before.status || after.message !== before.message;
    };
    if (!reads(a)) continue;
    out.push({
      id: `frame:unloaded${out.length ? `#${out.length + 1}` : ''}`,
      description: `the frame ${f.node.name ? JSON.stringify(f.node.name) : (f.node.url ?? '')} never loaded`,
      snapshot: snap,
    });
  }
  return out;
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
    for (const m of [...assertionMutants(s, idx, c.assert), ...frameMutants(s, idx, c.assert)])
      out.push({ ...m, id: `${c.id}:${m.id}`, check: c.id });
  }
  out.push(claimsOnly(s));
  return out;
}
