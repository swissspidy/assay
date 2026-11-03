/**
 * Invalid mutants: near misses derived from a correct snapshot by breaking the
 * evidence a check relies on. A check set must reject every mutant (verdict
 * fail, or at worst abstain). A check that still passes when its own evidence
 * is broken is flagged as weak.
 */
import type { Assertion, AXNode, CheckSet, EvidenceSnapshot, Json, JsonSchema, Locator, TextMatch } from '../types.ts';
import { AXIndex, resolveTarget, type INode } from '../runtime/axindex.ts';
import { matchRequest } from '../runtime/network.ts';
import { compileSchema, jsonPointer } from '../runtime/compare.ts';
import { applyNormalizers } from '../runtime/values.ts';
import { stripGlobal } from '../text.ts';
import { clone, editById, nearMiss, replaceText, setPointer } from './edit.ts';

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

function exampleFor(m: TextMatch | undefined): string | undefined {
  if (m === undefined) return undefined;
  if (typeof m === 'string') return m;
  if ('equals' in m) return m.equals;
  if ('contains' in m) return m.contains;
  return undefined; // cannot synthesize a regex match reliably
}

function synthesize(loc: Locator): AXNode | undefined {
  if (loc.text !== undefined && exampleFor(loc.text) === undefined) return undefined;
  if (loc.name !== undefined && exampleFor(loc.name) === undefined) return undefined;
  const name = exampleFor(loc.name);
  const text = exampleFor(loc.text) ?? name;
  return {
    role: loc.role,
    ...(name !== undefined ? { name } : {}),
    ...(loc.level !== undefined ? { level: loc.level } : {}),
    ...(text !== undefined ? { children: [{ role: 'text', name: text }] } : {}),
  };
}

/** Break the value a node-derived source reads, honouring its extract step. */
function perturbNodeValue(
  s: EvidenceSnapshot,
  node: INode,
  idx: AXIndex,
  a: Extract<Assertion, { kind: 'value' }>,
): M[] {
  if (a.source.from !== 'node') return [];
  const field = a.source.field;
  const raw = field === 'text' ? idx.text(node) : node.node[field];
  if (raw === undefined) return [];
  let span = raw.trim();
  const first = a.normalize?.[0];
  if (first && typeof first === 'object' && first.op === 'extract') {
    const m = new RegExp(first.regex, stripGlobal(first.flags)).exec(raw);
    const g = first.group ?? (m && m.length > 1 ? 1 : 0);
    const got = m ? (typeof g === 'number' ? m[g] : m.groups?.[g]) : undefined;
    if (!got) return [];
    span = got;
  }
  let typed;
  try {
    typed = applyNormalizers({ type: 'string', value: raw }, a.normalize);
  } catch {
    return [];
  }
  const alts: string[] = [];
  if (typed.type === 'number' || typed.type === 'money') {
    const digits = /\d+(?:[.,]\d+)?/.exec(span);
    if (digits) {
      const d = digits[0];
      const bumped = d.replace(/(\d)(?!.*\d)/, (x) => String((Number(x) + 1) % 10));
      alts.push(span.replace(d, bumped));
      alts.push(span.replace(d, `1${d}`));
    }
  } else if (typed.type === 'date') {
    const day = /\b(\d{1,2})\b/.exec(span);
    if (day) alts.push(span.replace(day[1]!, String((Number(day[1]) % 27) + 1)));
  } else if (typed.type === 'boolean') {
    alts.push(typed.value ? 'no' : 'yes');
  } else {
    alts.push(String(nearMiss(span)));
  }
  return alts
    .filter((alt) => alt !== span)
    .map((alt, i) => ({
      id: `value:${i}`,
      description: `value shown as ${JSON.stringify(alt)} instead of ${JSON.stringify(span)}`,
      snapshot: editById(s, (n, id) => (id === node.id ? (replaceText(n, span, alt) ?? n) : undefined)),
    }));
}

function mutateNetworkBodies(
  s: EvidenceSnapshot,
  seqs: number[],
  which: 'requestBody' | 'responseBody',
  pointer: string,
): EvidenceSnapshot | null {
  const out = clone(s);
  let changed = false;
  for (const e of out.network ?? []) {
    if (!seqs.includes(e.seq)) continue;
    const body = e[which];
    if (body === undefined) continue;
    if (pointer === '') {
      e[which] = nearMiss(body);
      changed = true;
      continue;
    }
    const cur = jsonPointer(body, pointer);
    if (cur === undefined) continue;
    if (setPointer(body, pointer, nearMiss(cur))) changed = true;
  }
  return changed ? out : null;
}

type Schema = Record<string, unknown>;

/** A value satisfying a simple schema built from consts (for inserting forbidden items). */
function exampleOf(schema: unknown): Json | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const sc = schema as Schema;
  if ('const' in sc) return sc.const as Json;
  if (Array.isArray(sc.enum) && sc.enum.length) return sc.enum[0] as Json;
  const props = sc.properties as Record<string, unknown> | undefined;
  if (props) {
    const o: Record<string, Json> = {};
    for (const [k, v] of Object.entries(props)) {
      const e = exampleOf(v);
      if (e !== undefined) o[k] = e;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return undefined;
}

/**
 * Near misses of `value` that violate what `schema` pins down: const/enum values
 * changed, required matching array items removed (contains), forbidden items
 * inserted (not.contains), recursing into properties.
 */
export function schemaViolations(schema: unknown, value: Json): { what: string; value: Json }[] {
  if (!schema || typeof schema !== 'object') return [];
  const sc = schema as Schema;
  const out: { what: string; value: Json }[] = [];
  if ('const' in sc || 'enum' in sc) out.push({ what: 'pinned value changed', value: nearMiss(value) });
  if (Array.isArray(value)) {
    if (sc.contains) {
      const fn = compileSchema(sc.contains as JsonSchema);
      const kept = value.filter((x) => !fn(x));
      if (kept.length !== value.length) out.push({ what: 'required item missing', value: kept });
    }
    const not = sc.not as Schema | undefined;
    if (not?.contains) {
      const item = exampleOf(not.contains);
      if (item !== undefined)
        out.push({ what: `forbidden item ${JSON.stringify(item)} present`, value: [...value, item] });
    }
  }
  const props = sc.properties as Record<string, unknown> | undefined;
  if (props && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, sub] of Object.entries(props)) {
      if (!(k in value)) continue;
      for (const v of schemaViolations(sub, value[k]!))
        out.push({ what: `${k}: ${v.what}`, value: { ...value, [k]: v.value } });
    }
  }
  return out;
}

/** Mutants of the matched bodies that violate the schema. */
function bodyViolations(
  s: EvidenceSnapshot,
  seqs: number[],
  which: 'requestBody' | 'responseBody',
  schema: unknown,
  pointer = '',
): M[] {
  const out: M[] = [];
  const first = s.network?.find((e) => seqs.includes(e.seq) && e[which] !== undefined);
  if (!first) return out;
  const current = jsonPointer(first[which]!, pointer);
  if (current === undefined) return out;
  for (const [i, v] of schemaViolations(schema, current).entries()) {
    const snap = clone(s);
    for (const e of snap.network ?? []) {
      if (!seqs.includes(e.seq) || e[which] === undefined) continue;
      if (pointer === '') e[which] = clone(v.value);
      else setPointer(e[which]!, pointer, clone(v.value));
    }
    out.push({
      id: `${which}:schema:${i}`,
      description: `${which}${pointer ? ' at ' + pointer : ''}: ${v.what}`,
      snapshot: snap,
    });
  }
  return out;
}

function assertionMutants(s: EvidenceSnapshot, a: Assertion): M[] {
  const idx = new AXIndex(s.a11y);
  switch (a.kind) {
    case 'state': {
      const r = resolveTarget(idx, a.target);
      if (!r.ok) return [];
      const target = r.node.id;
      const out: M[] = [];
      for (const k of ['checked', 'pressed', 'selected', 'expanded', 'disabled'] as const) {
        const want = a.expect[k];
        if (want === undefined) continue;
        const flipped = want !== true;
        out.push({
          id: `state:${k}`,
          description: `${k} is ${flipped} instead of ${String(want)}`,
          snapshot: editById(s, (n, id) =>
            id === target ? { ...n, states: { ...n.states, [k]: flipped } } : undefined,
          ),
        });
      }
      for (const k of ['value', 'name'] as const) {
        const cur = r.node.node[k];
        if (a.expect[k] === undefined || cur === undefined) continue;
        out.push({
          id: `state:${k}`,
          description: `${k} is ${JSON.stringify(nearMiss(cur))}`,
          snapshot: editById(s, (n, id) => (id === target ? { ...n, [k]: nearMiss(cur) as string } : undefined)),
        });
      }
      if (a.expect.level !== undefined) {
        out.push({
          id: 'state:level',
          description: 'heading level changed',
          snapshot: editById(s, (n, id) => (id === target ? { ...n, level: (a.expect.level! % 6) + 1 } : undefined)),
        });
      }
      return out;
    }
    case 'contains': {
      let scope = idx.root;
      if (a.scope) {
        const r = resolveTarget(idx, a.scope);
        if (!r.ok) return [];
        scope = r.node;
      }
      const hits = new Set(idx.find(a.match, scope).map((n) => n.id));
      const count = a.count ?? { gte: 1 };
      const wantsAbsence = count.eq === 0 || count.lte === 0 || count.lt === 1;
      if (!wantsAbsence) {
        return [
          {
            id: 'contains:removed',
            description: `the matching item(s) are missing (${hits.size} removed)`,
            snapshot: editById(s, (n, id) => (hits.has(id) ? null : undefined)),
          },
        ];
      }
      const node = synthesize(a.match);
      if (!node) return [];
      const scopeId = scope.id;
      return [
        {
          id: 'contains:present',
          description: `an item that should be absent (${node.role} ${JSON.stringify(node.name ?? '')}) is present`,
          snapshot: editById(s, (n, id) =>
            id === scopeId ? { ...n, children: [...(n.children ?? []), node] } : undefined,
          ),
        },
      ];
    }
    case 'value': {
      const src = a.source;
      switch (src.from) {
        case 'node': {
          const r = resolveTarget(idx, src.target);
          return r.ok ? perturbNodeValue(s, r.node, idx, a) : [];
        }
        case 'text': {
          const m = new RegExp(src.pattern, stripGlobal(src.flags)).exec(s.text);
          const g = src.group ?? (m && m.length > 1 ? 1 : 0);
          const got = m ? (typeof g === 'number' ? m[g] : m.groups?.[g]) : undefined;
          if (!got) return [];
          const alt = String(nearMiss(got));
          const snap = clone(s);
          snap.text = snap.text.replace(got, alt);
          return [
            {
              id: 'text:value',
              description: `page text shows ${JSON.stringify(alt)}`,
              snapshot: editById(snap, (n) =>
                n.role === 'text' && n.name?.includes(got) ? { ...n, name: n.name.replace(got, alt) } : undefined,
              ),
            },
          ];
        }
        case 'url': {
          const u = new URL(s.page.url);
          if (typeof src.part === 'object') {
            const cur = u.searchParams.get(src.part.param);
            if (cur === null) return [];
            u.searchParams.set(src.part.param, String(nearMiss(cur)));
          } else if (src.part === 'pathname') u.pathname = String(nearMiss(u.pathname));
          else return [];
          return [
            {
              id: 'url:value',
              description: `URL ${String(typeof src.part === 'object' ? src.part.param : src.part)} changed`,
              snapshot: { ...clone(s), page: { ...s.page, url: u.toString() } },
            },
          ];
        }
        case 'request':
        case 'response': {
          const seqs = (s.network ?? []).filter((e) => matchRequest(src.match, e) === 'yes').map((e) => e.seq);
          if (!seqs.length) return [];
          const which = src.from === 'request' ? 'requestBody' : 'responseBody';
          if ('schema' in a.expect) return bodyViolations(s, seqs, which, a.expect.schema, src.pointer ?? '');
          const snap = mutateNetworkBodies(s, seqs, which, src.pointer ?? '');
          return snap
            ? [
                {
                  id: `${src.from}:value`,
                  description: `${src.from} body value at ${src.pointer ?? '/'} changed`,
                  snapshot: snap,
                },
              ]
            : [];
        }
        case 'storage': {
          if (!s.storage) return [];
          const out: M[] = [];
          const changed = clone(s);
          const removed = clone(s);
          if (src.area === 'cookie') {
            const c = changed.storage!.cookies.find((x) => x.name === src.key);
            if (!c || typeof c.value !== 'string') return [];
            c.value = String(nearMiss(c.value));
            removed.storage!.cookies = removed.storage!.cookies.filter((x) => x.name !== src.key);
          } else {
            const origin = src.origin ? new URL(src.origin).origin : new URL(s.page.url).origin;
            const area = changed.storage![src.area][origin];
            if (!area || area[src.key] === undefined) return [];
            area[src.key] = String(nearMiss(area[src.key]!));
            delete removed.storage![src.area][origin]![src.key];
          }
          out.push({
            id: 'storage:value',
            description: `${src.area} ${src.key} has a different value`,
            snapshot: changed,
          });
          out.push({ id: 'storage:unset', description: `${src.area} ${src.key} is not set`, snapshot: removed });
          return out;
        }
        case 'probe': {
          const p = s.probes[src.probe];
          if (!p?.ok) return [];
          const current = jsonPointer(p.value, src.pointer);
          if (current === undefined) return [];
          // For schema comparisons only schema-derived violations are definite near misses.
          const replacements: { what: string; value: Json }[] =
            'schema' in a.expect
              ? schemaViolations(a.expect.schema, current)
              : [{ what: 'a different value', value: nearMiss(current) }];
          const out: M[] = [];
          for (const [i, r] of replacements.entries()) {
            const snap = clone(s);
            const pr = snap.probes[src.probe] as { ok: true; value: Json };
            if (!src.pointer) pr.value = clone(r.value);
            else if (!setPointer(pr.value, src.pointer, clone(r.value))) continue;
            out.push({ id: `probe:${i}`, description: `backend probe ${src.probe} reports ${r.what}`, snapshot: snap });
          }
          return out;
        }
      }
      return [];
    }
    case 'url': {
      const u = new URL(s.page.url);
      return [
        {
          id: 'url:elsewhere',
          description: 'the browser ended on a different page',
          snapshot: { ...clone(s), page: { ...s.page, url: `${u.origin}/elsewhere` } },
        },
      ];
    }
    case 'request': {
      if (!s.network) return [];
      const hits = s.network.filter((e) => matchRequest(a.match, e) === 'yes').map((e) => e.seq);
      if (!hits.length) return [];
      const count = a.count ?? { gte: 1 };
      if (count.eq === 0 || count.lte === 0 || count.lt === 1) return [];
      const out: M[] = [
        {
          id: 'request:missing',
          description: 'the request was never sent',
          snapshot: { ...clone(s), network: s.network.filter((e) => !hits.includes(e.seq)) },
        },
        {
          id: 'request:failed',
          description: 'the request failed with HTTP 500',
          snapshot: {
            ...clone(s),
            network: clone(s.network).map((e) =>
              hits.includes(e.seq) ? { ...e, status: 500, responseBody: { error: 'Internal Server Error' } } : e,
            ),
          },
        },
      ];
      for (const [which, schema] of [
        ['requestBody', a.match.requestBody],
        ['responseBody', a.match.responseBody],
      ] as const) {
        if (schema !== undefined)
          out.push(...bodyViolations(s, hits, which, schema).map((m) => ({ ...m, id: `request:${m.id}` })));
      }
      return out;
    }
    case 'allOf':
      return a.of.flatMap((sub, i) => assertionMutants(s, sub).map((m) => ({ ...m, id: `allOf[${i}]:${m.id}` })));
    case 'anyOf': {
      // Only breaking every alternative at once is a definite near miss.
      let snap = s;
      const parts: string[] = [];
      for (const sub of a.of) {
        const first = assertionMutants(snap, sub)[0];
        if (!first) return [];
        snap = first.snapshot;
        parts.push(first.description);
      }
      return [{ id: 'anyOf:all', description: `every alternative broken: ${parts.join('; ')}`, snapshot: snap }];
    }
  }
}

/** The page still claims success, but nothing structured happened. */
function claimsOnly(s: EvidenceSnapshot): Mutant {
  const out = clone(s);
  if (out.network) out.network = out.network.filter((e) => e.method === 'GET');
  if (out.storage) out.storage = { cookies: [], local: {}, session: {} };
  for (const k of Object.keys(out.probes)) out.probes[k] = { ok: false, error: 'not reachable' };
  return {
    id: 'claims-only',
    description:
      'the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable',
    snapshot: out,
    advisory: true,
  };
}

const CLAIM: AXNode = {
  role: 'status',
  children: [{ role: 'text', name: 'Success! Your request has been completed.' }],
};

/** Adds a success claim to a mutant; it must not turn a rejection into success. */
export function withSuccessClaim(m: Mutant): Mutant {
  const s = editById(m.snapshot, (n) =>
    n.role === 'main' ? { ...n, children: [clone(CLAIM), ...(n.children ?? [])] } : undefined,
  );
  s.text = `Success! Your request has been completed.\n${s.text}`;
  return { ...m, id: `${m.id}+claim`, description: `${m.description}, while the page announces success`, snapshot: s };
}

export function generateMutants(cs: CheckSet, s: EvidenceSnapshot): Mutant[] {
  const out: Mutant[] = [];
  for (const c of cs.checks) {
    for (const m of assertionMutants(s, c.assert)) out.push({ ...m, id: `${c.id}:${m.id}`, check: c.id });
  }
  out.push(claimsOnly(s));
  return out;
}
