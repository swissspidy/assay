/**
 * `assay checks print --ts`: builder code for a check set (ADR 0019). Every construct is
 * printed with the builder call that produces it, and the printer checks that by running
 * the same call: where the result would differ in any way, it prints the plain object
 * instead (the builder takes those everywhere). So the printed module always evaluates to a
 * check set deep-equal to the input.
 */
import { isDeepStrictEqual } from 'node:util';
import type {
  Assertion,
  CheckSet,
  Comparison,
  Json,
  JsonSchema,
  Locator,
  Normalizer,
  NumberCompare,
  RequestMatch,
  Target,
  ValueSource,
} from '../types.ts';
import {
  allOf,
  anyOf,
  contains,
  defaultDescription,
  each,
  like,
  matching,
  network,
  node,
  norm,
  page,
  probe,
  quoteField,
  storage,
  text,
  url,
  value,
  type AssertionBuilder,
  type Bound,
  type LikeShape,
  type RequestRef,
  type Value,
} from './builder.ts';

// ---------------------------------------------------------------------------
// A tiny pretty printer
// ---------------------------------------------------------------------------

type Doc =
  | { t: 'atom'; s: string }
  | { t: 'call'; head: string; args: Doc[] }
  | { t: 'obj'; entries: [string, Doc][] }
  | { t: 'arr'; items: Doc[] }
  | { t: 'chain'; base: Doc; calls: { name: string; args: Doc[] }[] };

const WIDTH = 100;
const atom = (s: string): Doc => ({ t: 'atom', s });
const call = (head: string, ...args: Doc[]): Doc => ({ t: 'call', head, args });
const chain = (base: Doc, name: string, ...args: Doc[]): Doc =>
  base.t === 'chain'
    ? { ...base, calls: [...base.calls, { name, args }] }
    : { t: 'chain', base, calls: [{ name, args }] };

function flat(d: Doc): string {
  switch (d.t) {
    case 'atom':
      return d.s;
    case 'call':
      return `${d.head}(${d.args.map(flat).join(', ')})`;
    case 'obj':
      return d.entries.length ? `{ ${d.entries.map(([k, v]) => `${k}: ${flat(v)}`).join(', ')} }` : '{}';
    case 'arr':
      return `[${d.items.map(flat).join(', ')}]`;
    case 'chain':
      return flat(d.base) + d.calls.map((c) => `.${c.name}(${c.args.map(flat).join(', ')})`).join('');
  }
}

/**
 * `d` at `indent`, its first line starting `offset` columns further right (after `key: `),
 * followed by `tail` characters (a comma): flat if it fits, else broken over lines.
 */
function render(d: Doc, indent: number, offset = 0, tail = 1): string {
  const f = flat(d);
  if (indent + offset + f.length + tail <= WIDTH) return f;
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const list = (items: Doc[], open: string, close: string) =>
    `${open}\n${items.map((x) => `${inner}${render(x, indent + 2)},`).join('\n')}\n${pad}${close}`;
  switch (d.t) {
    case 'atom':
      return d.s;
    case 'call':
      return list(d.args, `${d.head}(`, ')');
    case 'obj':
      return `{\n${d.entries.map(([k, v]) => `${inner}${k}: ${render(v, indent + 2, k.length + 2)},`).join('\n')}\n${pad}}`;
    case 'arr':
      return list(d.items, '[', ']');
    case 'chain': {
      // A short chain stays on one line and breaks only its last call's arguments:
      // `probe('order').like({` … `})`, `node('main').each(` … `)`.
      const last = d.calls.at(-1)!;
      const head =
        flat(d.base) +
        d.calls
          .slice(0, -1)
          .map((c) => `.${c.name}(${c.args.map(flat).join(', ')})`)
          .join('');
      if (d.calls.length <= 2 && indent + offset + head.length + last.name.length + 2 <= WIDTH) {
        const [only] = last.args;
        if (last.args.length === 1 && only && only.t !== 'atom' && only.t !== 'chain')
          return `${head}.${last.name}(${render(only, indent, offset + head.length + last.name.length + 2, tail + 1)})`;
        return `${head}.${last.name}(\n${last.args.map((a) => `${inner}${render(a, indent + 2)},`).join('\n')}\n${pad})`;
      }
      return (
        render(d.base, indent, offset, 0) +
        d.calls
          .map((c) => {
            const one = `.${c.name}(${c.args.map(flat).join(', ')})`;
            if (indent + 2 + one.length + tail <= WIDTH) return `\n${inner}${one}`;
            return `\n${inner}.${c.name}(\n${c.args.map((a) => `${inner}  ${render(a, indent + 4)},`).join('\n')}\n${inner})`;
          })
          .join('')
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** A string literal: single-quoted, or double-quoted when that needs fewer escapes (as Prettier does). */
export function str(s: string): string {
  const escaped = JSON.stringify(s).slice(1, -1).replaceAll(LS, '\\u2028').replaceAll(PS, '\\u2029');
  if (s.includes("'") && !s.includes('"')) return `"${escaped}"`;
  return `'${escaped.replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}

/** A string literal as a doc. */
const strDoc = (x: string): Doc => atom(str(x));

const IDENT = /^[A-Za-z_$][\w$]*$/;
const key = (k: string) => (k === '__proto__' ? `[${str(k)}]` : IDENT.test(k) ? k : str(k));

function json(v: Json | undefined): Doc {
  if (v === null || typeof v !== 'object')
    return atom(v === undefined ? 'undefined' : typeof v === 'string' ? str(v) : JSON.stringify(v));
  if (Array.isArray(v)) return { t: 'arr', items: v.map(json) };
  return { t: 'obj', entries: Object.entries(v).map(([k, x]) => [key(k), json(x)]) };
}

/** An object of optional arguments: only the keys that are set. */
function opts(o: Record<string, Doc | undefined>): Doc | undefined {
  const entries = Object.entries(o).filter((e): e is [string, Doc] => e[1] !== undefined);
  return entries.length ? { t: 'obj', entries: entries.map(([k, v]) => [key(k), v]) } : undefined;
}
const args = (...xs: (Doc | undefined)[]): Doc[] => {
  const out = [...xs];
  while (out.length && out[out.length - 1] === undefined) out.pop();
  return out.map((x) => x ?? atom('undefined'));
};

/**
 * A regex literal for `source` and `flags`, when one reads back as exactly them: RegExp's
 * `source` escapes what a literal could not hold (`/`, line breaks), so a source it leaves
 * as it is can be written between slashes. Flags must be in their canonical order.
 */
function regexLiteral(source: string, flags: string | undefined): string | undefined {
  if (flags === '' || !source) return undefined;
  try {
    const r = new RegExp(source, flags);
    return r.source === source && r.flags === (flags ?? '') ? `/${source}/${flags ?? ''}` : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Builder code, checked by construction
// ---------------------------------------------------------------------------

/** A printed expression and the value the builder gives for it. */
interface Printed<T> {
  doc: Doc;
  value: T;
}

class Printer {
  readonly imports = new Set<string>();
  use(name: string): string {
    this.imports.add(name.split('.')[0]!);
    return name;
  }

  /** `printed` if its value equals `want`, else the plain literal of `want`. */
  check<T>(want: T, printed: () => Printed<unknown> | undefined, fallback: () => Doc = () => json(want as Json)): Doc {
    let p: Printed<unknown> | undefined;
    try {
      p = printed();
    } catch {
      p = undefined;
    }
    return p && isDeepStrictEqual(plain(p.value), want) ? p.doc : fallback();
  }

  // --- schemas ------------------------------------------------------------

  /** A JSON Schema as a `like(...)` shape where the shape gives it back exactly. */
  schema(s: JsonSchema): Doc {
    const shape = this.shapeOf(s);
    return shape ? call(this.use('like'), shape.doc) : json(s as Json);
  }

  /** The `like` shape of a schema (and its builder value), or undefined. */
  shapeOf(s: JsonSchema): Printed<LikeShape> | undefined {
    const top = this.shape(s, true);
    if (!top) return undefined;
    return isDeepStrictEqual(plain(like(top.value)), s) ? top : undefined;
  }

  private shape(s: unknown, top: boolean): Printed<LikeShape> | undefined {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return top ? undefined : this.raw(s);
    const o = s as Record<string, unknown>;
    const keys = Object.keys(o);
    const is = (...k: string[]) => keys.length === k.length && k.every((x) => keys.includes(x));
    if (is('const') && (o.const === null || typeof o.const !== 'object'))
      return { doc: json(o.const as Json), value: o.const as LikeShape };
    if (is('type', 'contains') && o.type === 'array') {
      const item = this.shape(o.contains, false);
      return item && { doc: { t: 'arr', items: [item.doc] }, value: [item.value] };
    }
    if (is('type', 'allOf') && o.type === 'array' && Array.isArray(o.allOf) && o.allOf.length > 1) {
      const items = o.allOf.map((x) =>
        x && typeof x === 'object' && Object.keys(x).length === 1 && 'contains' in x
          ? this.shape((x as { contains: unknown }).contains, false)
          : undefined,
      );
      if (items.some((x) => !x)) return top ? undefined : this.raw(s);
      return { doc: { t: 'arr', items: items.map((x) => x!.doc) }, value: items.map((x) => x!.value) };
    }
    if (is('type', 'required', 'properties') && o.type === 'object') {
      const req = o.required;
      const props = o.properties as Record<string, unknown>;
      if (
        Array.isArray(req) &&
        props &&
        typeof props === 'object' &&
        !Array.isArray(props) &&
        isDeepStrictEqual(req, Object.keys(props)) &&
        req.length > 0 &&
        !req.includes('__proto__')
      ) {
        const entries = req.map((k: string) => [k, this.shape(props[k], false)] as const);
        if (entries.every(([, v]) => v)) {
          return {
            doc: { t: 'obj', entries: entries.map(([k, v]) => [key(k), v!.doc]) },
            value: Object.fromEntries(entries.map(([k, v]) => [k, v!.value])),
          };
        }
      }
    }
    return top ? undefined : this.raw(s);
  }

  private raw(s: unknown): Printed<LikeShape> {
    return { doc: call(this.use('matching'), json(s as Json)), value: matching(s as JsonSchema) };
  }

  // --- targets and sources ------------------------------------------------

  target(t: Target): Doc {
    if ('anchors' in t) return call(this.use('anchors'), ...t.anchors.map((l) => json(l as unknown as Json)));
    return json(t as unknown as Json);
  }

  node(t: Target): Doc {
    if (!('anchors' in t)) {
      const keys = Object.keys(t);
      if (keys.every((k) => k === 'role' || k === 'name'))
        return call(this.use('node'), atom(str(t.role)), ...(t.name !== undefined ? [json(t.name as Json)] : []));
    }
    return call(this.use('node'), this.target(t));
  }

  requestRef(m: RequestMatch): Printed<RequestRef> | undefined {
    const METHODS: Record<string, 'get' | 'post' | 'put' | 'patch' | 'delete'> = {
      GET: 'get',
      POST: 'post',
      PUT: 'put',
      PATCH: 'patch',
      DELETE: 'delete',
    };
    const short = typeof m.method === 'string' && m.url && METHODS[m.method];
    let doc: Doc;
    let ref: RequestRef;
    if (short) {
      const u = m.url!;
      const path = Object.keys(u).length === 1 && u.path !== undefined;
      doc = call(this.use(`network.${short}`), path ? atom(str(u.path!)) : json(u as Json));
      ref = network[short](path ? u.path! : u);
    } else {
      const base: RequestMatch = {
        ...(m.method !== undefined ? { method: m.method } : {}),
        ...(m.url !== undefined ? { url: m.url } : {}),
      };
      doc = call(this.use('network.request'), ...(Object.keys(base).length ? [json(base as Json)] : []));
      ref = network.request(base);
    }
    if (m.status !== undefined) {
      doc = chain(doc, 'status', json(m.status as Json));
      ref = ref.status(m.status);
    }
    if (m.requestBody !== undefined) {
      doc = chain(doc, 'requestBody', this.schema(m.requestBody));
      ref = ref.requestBody(m.requestBody);
    }
    if (m.responseBody !== undefined) {
      doc = chain(doc, 'responseBody', this.schema(m.responseBody));
      ref = ref.responseBody(m.responseBody);
    }
    return { doc, value: ref };
  }

  source(src: ValueSource): Printed<Value> {
    const fallback = (): Printed<Value> => ({ doc: call(this.use('value'), json(src as Json)), value: value(src) });
    let p: Printed<Value> | undefined;
    try {
      p = this.sourceSugar(src);
    } catch {
      p = undefined;
    }
    return p && isDeepStrictEqual(plain(p.value.source), src) ? p : fallback();
  }

  private sourceSugar(src: ValueSource): Printed<Value> | undefined {
    switch (src.from) {
      case 'node': {
        const n = node(src.target);
        return { doc: chain(this.node(src.target), src.field), value: n[src.field]() };
      }
      case 'text': {
        const lit = regexLiteral(src.pattern, src.flags);
        const pattern = lit ? atom(lit) : atom(str(src.pattern));
        const o = opts({
          scope: src.scope ? this.target(src.scope) : undefined,
          flags: !lit && src.flags !== undefined ? atom(str(src.flags)) : undefined,
          group: src.group !== undefined ? json(src.group) : undefined,
        });
        const v = text(lit ? new RegExp(src.pattern, src.flags) : src.pattern, {
          ...(src.scope ? { scope: src.scope } : {}),
          ...(!lit && src.flags !== undefined ? { flags: src.flags } : {}),
          ...(src.group !== undefined ? { group: src.group } : {}),
        });
        return { doc: call(this.use('text'), ...args(pattern, o)), value: v };
      }
      case 'url':
        return typeof src.part === 'string'
          ? { doc: call(this.use('url.part'), atom(str(src.part))), value: url.part(src.part) }
          : { doc: call(this.use('url.param'), atom(str(src.part.param))), value: url.param(src.part.param) };
      case 'request':
      case 'response': {
        const r = this.requestRef(src.match);
        if (!r) return undefined;
        const read =
          src.pick !== undefined
            ? opts({
                pointer: src.pointer !== undefined ? atom(str(src.pointer)) : undefined,
                pick: atom(str(src.pick)),
              })
            : src.pointer !== undefined
              ? atom(str(src.pointer))
              : undefined;
        const readValue =
          src.pick !== undefined
            ? { ...(src.pointer !== undefined ? { pointer: src.pointer } : {}), pick: src.pick }
            : src.pointer;
        return {
          doc: chain(r.doc, src.from, ...(read ? [read] : [])),
          value: r.value[src.from](readValue),
        };
      }
      case 'storage': {
        const o = opts({
          origin: src.origin !== undefined ? atom(str(src.origin)) : undefined,
          at: src.at !== undefined ? atom(str(src.at)) : undefined,
        });
        return {
          doc: call(this.use(`storage.${src.area}`), ...args(atom(str(src.key)), o)),
          value: storage[src.area](src.key, {
            ...(src.origin !== undefined ? { origin: src.origin } : {}),
            ...(src.at !== undefined ? { at: src.at } : {}),
          }),
        };
      }
      case 'probe': {
        const second =
          src.at !== undefined
            ? opts({
                pointer: src.pointer !== undefined ? atom(str(src.pointer)) : undefined,
                at: atom(str(src.at)),
              })
            : src.pointer !== undefined
              ? atom(str(src.pointer))
              : undefined;
        const v =
          src.at !== undefined
            ? probe(src.probe, { ...(src.pointer !== undefined ? { pointer: src.pointer } : {}), at: src.at })
            : probe(src.probe, src.pointer);
        return { doc: call(this.use('probe'), ...args(atom(str(src.probe)), second)), value: v };
      }
    }
  }

  normalizer(n: Normalizer): Doc {
    if (typeof n === 'string') return atom(str(n));
    return this.check(n, () => {
      switch (n.op) {
        case 'number':
          return { doc: call(this.use('norm.number'), strDoc(n.locale)), value: norm.number(n.locale) };
        case 'currency':
          return {
            doc: call(
              this.use('norm.currency'),
              strDoc(n.locale),
              ...(n.currency !== undefined ? [strDoc(n.currency)] : []),
            ),
            value: norm.currency(n.locale, n.currency),
          };
        case 'date':
        case 'datetime':
          return {
            doc: call(
              this.use(`norm.${n.op}`),
              strDoc(n.locale),
              ...(n.timezone !== undefined ? [strDoc(n.timezone)] : []),
            ),
            value: norm[n.op](n.locale, n.timezone),
          };
        case 'extract': {
          const lit = regexLiteral(n.regex, n.flags);
          const o = opts({
            flags: !lit && n.flags !== undefined ? strDoc(n.flags) : undefined,
            group: n.group !== undefined ? json(n.group) : undefined,
          });
          return {
            doc: call(this.use('norm.extract'), ...args(lit ? atom(lit) : strDoc(n.regex), o)),
            value: norm.extract(lit ? new RegExp(n.regex, n.flags) : n.regex, {
              ...(!lit && n.flags !== undefined ? { flags: n.flags } : {}),
              ...(n.group !== undefined ? { group: n.group } : {}),
            }),
          };
        }
        case 'replace': {
          const lit = regexLiteral(n.regex, n.flags);
          return {
            doc: call(
              this.use('norm.replace'),
              lit ? atom(lit) : strDoc(n.regex),
              strDoc(n.with),
              ...(!lit && n.flags !== undefined ? [strDoc(n.flags)] : []),
            ),
            value: lit ? norm.replace(new RegExp(n.regex, n.flags), n.with) : norm.replace(n.regex, n.with, n.flags),
          };
        }
        case 'items': {
          const o = opts({
            where: n.where !== undefined ? this.schema(n.where) : undefined,
            pointer: n.pointer !== undefined ? strDoc(n.pointer) : undefined,
            pick: n.pick !== undefined ? json(n.pick) : undefined,
            flatten: n.flatten !== undefined ? json(n.flatten) : undefined,
          });
          return { doc: call(this.use('norm.items'), ...(o ? [o] : [])), value: norm.items(n) };
        }
        default:
          return undefined;
      }
    });
  }

  /** A value with its normalizers. */
  operand(src: ValueSource, steps: Normalizer[] | undefined): Printed<Value> {
    const s = this.source(src);
    if (!steps) return s;
    return {
      doc: chain(s.doc, 'normalize', ...steps.map((n) => this.normalizer(n))),
      value: s.value.normalize(...steps),
    };
  }

  comparison(v: Printed<Value>, c: Comparison): Printed<AssertionBuilder> {
    const k = Object.keys(c);
    const one = k.length === 1 ? k[0] : undefined;
    const ord = new Set(['gt', 'gte', 'lt', 'lte']);
    if (one === 'equals' && 'equals' in c)
      return { doc: chain(v.doc, 'equals', json(c.equals)), value: v.value.equals(c.equals) };
    if (one === 'oneOf' && 'oneOf' in c)
      return { doc: chain(v.doc, 'oneOf', json(c.oneOf)), value: v.value.oneOf(c.oneOf) };
    if (one === 'exists' && 'exists' in c) return { doc: chain(v.doc, 'exists'), value: v.value.exists() };
    if ('contains' in c && k.every((x) => x === 'contains' || x === 'ignoreCase')) {
      const o = opts({ ignoreCase: c.ignoreCase !== undefined ? json(c.ignoreCase) : undefined });
      return {
        doc: chain(v.doc, 'contains', ...args(atom(str(c.contains)), o)),
        value: v.value.contains(c.contains, c.ignoreCase !== undefined ? { ignoreCase: c.ignoreCase } : {}),
      };
    }
    if ('regex' in c && k.every((x) => x === 'regex' || x === 'flags')) {
      const lit = regexLiteral(c.regex, c.flags);
      return lit
        ? { doc: chain(v.doc, 'matches', atom(lit)), value: v.value.matches(new RegExp(c.regex, c.flags)) }
        : {
            doc: chain(v.doc, 'matches', atom(str(c.regex)), ...(c.flags !== undefined ? [atom(str(c.flags))] : [])),
            value: v.value.matches(c.regex, c.flags),
          };
    }
    if (one === 'approx' && 'approx' in c) {
      const { value: target, ...tol } = c.approx;
      return {
        doc: chain(v.doc, 'approx', json(target as Json), json(tol as Json)),
        value: v.value.approx(target, tol),
      };
    }
    if (k.length && k.every((x) => ord.has(x))) {
      const b = c as Record<'gt' | 'gte' | 'lt' | 'lte', Bound>;
      if (one) {
        const m = one as 'gt' | 'gte' | 'lt' | 'lte';
        return { doc: chain(v.doc, m, json(b[m] as Json)), value: v.value[m](b[m]) };
      }
      return { doc: chain(v.doc, 'range', json(c as Json)), value: v.value.range(b) };
    }
    if (one === 'schema' && 'schema' in c) {
      const shape = this.shapeOf(c.schema);
      return shape
        ? { doc: chain(v.doc, 'like', shape.doc), value: v.value.like(shape.value) }
        : { doc: chain(v.doc, 'schema', json(c.schema as Json)), value: v.value.schema(c.schema) };
    }
    if (one === 'sameAs' && 'sameAs' in c) {
      const other = this.operand(c.sameAs.source, c.sameAs.normalize);
      const o = opts({ tolerance: c.sameAs.tolerance ? json(c.sameAs.tolerance as unknown as Json) : undefined });
      return {
        doc: chain(v.doc, 'sameAs', ...args(other.doc, o)),
        value: v.value.sameAs(other.value, c.sameAs.tolerance ? { tolerance: c.sameAs.tolerance } : {}),
      };
    }
    return { doc: chain(v.doc, 'compare', json(c as Json)), value: v.value.compare(c) };
  }

  count(c: NumberCompare): Doc {
    const k = Object.keys(c);
    return k.length === 1 && k[0] === 'eq' ? json(c.eq!) : json(c as Json);
  }

  assertion(a: Assertion): Doc {
    return this.check(
      a,
      () => this.assertionSugar(a),
      () => json(a as unknown as Json),
    );
  }

  private assertionSugar(a: Assertion): Printed<AssertionBuilder> | undefined {
    switch (a.kind) {
      case 'state': {
        const n = this.node(a.target);
        const ref = node(a.target);
        const k = Object.keys(a.expect) as (keyof typeof a.expect)[];
        if (k.length === 1) {
          const f = k[0]!;
          const v = a.expect[f];
          if (f === 'checked' || f === 'pressed') {
            const x = v as boolean | 'mixed';
            return { doc: chain(n, f, ...(x === true ? [] : [json(x)])), value: ref[f](x) };
          }
          if (f === 'selected' || f === 'expanded' || f === 'disabled') {
            const x = v as boolean;
            return { doc: chain(n, f, ...(x === true ? [] : [json(x)])), value: ref[f](x) };
          }
          if (f === 'level') return { doc: chain(n, 'hasLevel', json(v as number)), value: ref.hasLevel(v as number) };
          const m = { text: 'hasText', name: 'hasName', value: 'hasValue' } as const;
          const name = m[f];
          return { doc: chain(n, name, json(v as Json)), value: ref[name](v as string) };
        }
        return { doc: chain(n, 'state', json(a.expect as Json)), value: ref.state(a.expect) };
      }
      case 'contains':
      case 'each': {
        const o = opts({
          witness: a.witness ? json(a.witness as unknown as Json) : undefined,
          count: a.count ? this.count(a.count) : undefined,
        });
        const ov = {
          ...(a.witness ? { witness: a.witness } : {}),
          ...(a.count ? { count: a.count } : {}),
        };
        const match = json(a.match as unknown as Json);
        const inner = a.kind === 'each' ? [this.assertion(a.assert)] : [];
        const innerValue = a.kind === 'each' ? a.assert : undefined;
        if (a.scope) {
          const n = this.node(a.scope);
          const ref = node(a.scope);
          return a.kind === 'each'
            ? { doc: chain(n, 'each', ...args(match, ...inner, o)), value: ref.each(a.match, innerValue!, ov) }
            : { doc: chain(n, 'contains', ...args(match, o)), value: ref.contains(a.match, ov) };
        }
        return a.kind === 'each'
          ? { doc: call(this.use('each'), ...args(match, ...inner, o)), value: each(a.match, innerValue!, ov) }
          : { doc: call(this.use('contains'), ...args(match, o)), value: contains(a.match as Locator, ov) };
      }
      case 'value':
        return this.comparison(this.operand(a.source, a.normalize), a.expect);
      case 'url': {
        const path = Object.keys(a.match).length === 1 && a.match.path !== undefined;
        return {
          doc: call(this.use('url'), path ? atom(str(a.match.path!)) : json(a.match as Json)),
          value: url(path ? a.match.path! : a.match),
        };
      }
      case 'request': {
        const r = this.requestRef(a.match);
        if (!r) return undefined;
        return a.count ? { doc: chain(r.doc, 'count', this.count(a.count)), value: r.value.count(a.count) } : r;
      }
      case 'page':
        return {
          doc: call(this.use('page'), json(a.match as Json), this.assertion(a.assert)),
          value: page(a.match, a.assert),
        };
      case 'allOf':
      case 'anyOf':
        return {
          doc: call(this.use(a.kind), ...a.of.map((x) => this.assertion(x))),
          value: (a.kind === 'allOf' ? allOf : anyOf)(...a.of),
        };
    }
  }
}

const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

export interface PrintOptions {
  /** The module the builder is imported from (default `@swissspidy/assay/checks`). */
  importFrom?: string;
}

/**
 * TypeScript builder code for a valid check set: a module whose default export is a check set
 * deep-equal to `cs`.
 */
export function printCheckSet(cs: CheckSet, options: PrintOptions = {}): string {
  const p = new Printer();
  const spec = opts({
    id: atom(str(cs.id)),
    version: atom(str(cs.version)),
    instruction: atom(str(cs.task.instruction)),
    outcomes: cs.task.outcomes !== undefined ? atom(str(cs.task.outcomes)) : undefined,
    compiled: cs.compiled ? json(cs.compiled as unknown as Json) : undefined,
    locked: cs.locked ? json(cs.locked as unknown as Json) : undefined,
    rejected: cs.rejected ? json(cs.rejected as unknown as Json) : undefined,
  })!;

  const reqDoc = (r: CheckSet['requirements'][number]): Doc => {
    const o = opts({
      kind: r.kind !== 'hard' ? atom(str(r.kind)) : undefined,
      quote: r.source.quote !== r.text ? atom(str(r.source.quote)) : undefined,
      field: quoteField(cs.task, r.source.quote) !== r.source.field ? atom(str(r.source.field)) : undefined,
    });
    return call(p.use('req'), ...args(atom(str(r.id)), atom(str(r.text)), o));
  };
  const checkArgs = (c: CheckSet['checks'][number], i: number): Doc[] => {
    const described = c.description === defaultDescription(c.assert);
    const o = opts({
      id: c.id !== `C${i + 1}` ? atom(str(c.id)) : undefined,
      onFail: c.onFail !== undefined ? atom(str(c.onFail)) : undefined,
      onMissing: c.onMissing !== undefined ? atom(str(c.onMissing)) : undefined,
    });
    return args(...(described ? [] : [atom(str(c.description))]), p.assertion(c.assert), o);
  };

  // Checks grouped by requirement, in the requirements' order, chain onto their requirement;
  // otherwise every check names its requirement, so the order is kept.
  const groups = cs.checks.map((c) => c.requirement).filter((r, i, all) => i === 0 || all[i - 1] !== r);
  const order = cs.requirements.map((r) => r.id).filter((id) => groups.includes(id));
  const grouped = groups.length === new Set(groups).size && isDeepStrictEqual(groups, order);

  const items: Doc[] = [];
  if (grouped) {
    for (const r of cs.requirements) {
      let d = reqDoc(r);
      cs.checks.forEach((c, i) => {
        if (c.requirement === r.id) d = chain(d, 'check', ...checkArgs(c, i));
      });
      items.push(d);
    }
  } else {
    items.push(...cs.requirements.map(reqDoc));
    cs.checks.forEach((c, i) => items.push(call(p.use('check'), atom(str(c.requirement)), ...checkArgs(c, i))));
  }
  const body = render(call(p.use('checks'), spec, { t: 'arr', items }), 0);
  const from = options.importFrom ?? '@swissspidy/assay/checks';
  const names = [...p.imports].toSorted();
  const head = `import { ${names.join(', ')} } from ${str(from)};`;
  const imports =
    head.length <= WIDTH ? head : `import {\n${names.map((n) => `  ${n},`).join('\n')}\n} from ${str(from)};`;
  return `${imports}\n\nexport default ${body};\n`;
}
