/**
 * Valid variants: edits of a correct snapshot that a correct outcome may show.
 * A check set must accept all of them; a check that rejects one is flagged
 * as over-constrained (it imposes a condition the task did not state).
 */
import type { Assertion, CheckSet, EvidenceSnapshot, Json, Normalizer, NetworkEntry } from '../types.ts';
import { AXIndex, resolveTarget } from '../runtime/axindex.ts';
import { applyNormalizers, type TypedValue } from '../runtime/values.ts';
import { stripGlobal } from '../text.ts';
import { clone, editById, replaceText } from './edit.ts';

export interface Variant {
  id: string;
  description: string;
  snapshot: EvidenceSnapshot;
}

const REORDERABLE = new Set(['list', 'rowgroup', 'listbox', 'menu', 'grid', 'tree', 'feed']);

function reorder(s: EvidenceSnapshot): EvidenceSnapshot | null {
  let changed = false;
  const out = editById(s, (n) => {
    if (!REORDERABLE.has(n.role) || !n.children || n.children.length < 2) return undefined;
    // keep header rows first: only reorder rows that contain cells
    const head = n.children.filter((c) => c.children?.some((g) => g.role === 'columnheader'));
    const body = n.children.filter((c) => !head.includes(c));
    if (body.length < 2) return undefined;
    changed = true;
    return { ...n, children: [...head, ...body.toReversed()] };
  });
  return changed ? out : null;
}

const UNRELATED = {
  region: {
    role: 'region',
    name: 'Recommended for you',
    children: [
      { role: 'heading', name: 'Recommended for you', level: 2 },
      {
        role: 'list',
        children: [
          { role: 'listitem', children: [{ role: 'text', name: 'Gift card' }] },
          { role: 'listitem', children: [{ role: 'text', name: 'Tea towel' }] },
        ],
      },
    ],
  },
  status: { role: 'status', children: [{ role: 'text', name: 'Free shipping on orders over $50.00' }] },
};

function extraContent(s: EvidenceSnapshot): EvidenceSnapshot {
  let placed = false;
  const out = editById(s, (n) => {
    if (n.role === 'main' && !placed) {
      placed = true;
      return { ...n, children: [...(n.children ?? []), clone(UNRELATED.region), clone(UNRELATED.status)] };
    }
    return undefined;
  });
  if (placed) return out;
  return { ...out, a11y: { ...out.a11y, children: [...(out.a11y.children ?? []), clone(UNRELATED.region)] } };
}

function extraTableRow(s: EvidenceSnapshot): EvidenceSnapshot | null {
  let changed = false;
  const out = editById(s, (n) => {
    if (n.role !== 'rowgroup' || !n.children?.length) return undefined;
    const sample = n.children.find((r) => r.role === 'row' && r.children?.some((c) => c.role === 'cell'));
    if (!sample) return undefined;
    changed = true;
    const cells = (sample.children ?? []).map((c, i) => ({ role: c.role, name: i === 0 ? 'Gift card' : '' }));
    return { ...n, children: [...n.children, { role: 'row', name: 'Gift card', children: cells }] };
  });
  return changed ? out : null;
}

function wrapMain(s: EvidenceSnapshot): EvidenceSnapshot | null {
  let changed = false;
  const out = editById(s, (n) => {
    if (n.role !== 'main' || changed) return undefined;
    changed = true;
    return { ...n, children: [{ role: 'region', name: 'Page content', children: n.children ?? [] }] };
  });
  return changed ? out : null;
}

/** Non-breaking space followed by a space: same rendering, different characters. */
const respace = (t: string) => t.replace(/ /g, '\u00a0 ');

function spacing(s: EvidenceSnapshot): EvidenceSnapshot {
  const out = editById(s, (n) => (n.name !== undefined ? { ...n, name: respace(n.name) } : undefined));
  out.text = out.text.replace(/ /g, '  ');
  return out;
}

function addFields(v: Json | undefined): Json | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) return { ...v, _links: { self: '/x' }, requestId: 'r-123' };
  if (Array.isArray(v)) return v.map((x) => addFields(x) as Json);
  return v;
}

function extraJsonFields(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const out = clone(s);
  let changed = false;
  for (const e of out.network ?? []) {
    for (const k of ['requestBody', 'responseBody'] as const) {
      const b = e[k];
      if (b && typeof b === 'object') {
        e[k] = addFields(b) as Json;
        changed = true;
      }
    }
  }
  for (const p of Object.values(out.probes)) {
    if (p.ok && p.value && typeof p.value === 'object') {
      p.value = addFields(p.value) as Json;
      changed = true;
    }
  }
  return changed ? out : null;
}

function networkNoise(s: EvidenceSnapshot): EvidenceSnapshot | null {
  if (!s.network) return null;
  const out = clone(s);
  const net = out.network!;
  let seq = Math.max(-1, ...net.map((e) => e.seq)) + 1;
  const origin = new URL(s.page.url).origin;
  const extra: NetworkEntry[] = [
    {
      seq: seq++,
      method: 'GET',
      url: `${origin}/analytics/collect?e=pageview`,
      resourceType: 'fetch',
      status: 204,
      requestHeaders: {},
      responseHeaders: {},
    },
  ];
  // a polling client re-fetches what it already fetched
  for (const e of net.filter((x) => x.method === 'GET' && x.resourceType === 'fetch' && x.status === 200).slice(0, 3)) {
    extra.push({ ...clone(e), seq: seq++ });
  }
  out.network = [...net, ...extra];
  return out;
}

function urlDecoration(s: EvidenceSnapshot): EvidenceSnapshot | null {
  let u: URL;
  try {
    u = new URL(s.page.url);
  } catch {
    return null;
  }
  u.searchParams.set('utm_source', 'newsletter');
  return { ...clone(s), page: { ...s.page, url: u.toString() } };
}

// --- value formatting variants -------------------------------------------------

function formatsFor(v: TypedValue, locale: string): string[] {
  if (v.type === 'money') {
    const n = v.value.amount;
    const c = v.value.currency;
    const out = [
      new Intl.NumberFormat(locale, { style: 'currency', currency: c }).format(n),
      new Intl.NumberFormat(locale, { style: 'currency', currency: c, currencyDisplay: 'code' }).format(n),
      `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(n)} ${c}`,
    ];
    if (Number.isInteger(n * 10) && !Number.isInteger(n)) {
      out.push(new Intl.NumberFormat(locale, { style: 'currency', currency: c, minimumFractionDigits: 1 }).format(n));
    }
    return out;
  }
  if (v.type === 'number') {
    return [
      new Intl.NumberFormat(locale, { useGrouping: true }).format(v.value),
      new Intl.NumberFormat(locale, { minimumFractionDigits: Number.isInteger(v.value) ? 0 : 2 }).format(v.value),
    ];
  }
  if (v.type === 'date') {
    const d = new Date(v.value + 'T00:00:00Z');
    return (['long', 'medium', 'short'] as const)
      .map((dateStyle) => new Intl.DateTimeFormat(locale, { dateStyle, timeZone: 'UTC' }).format(d))
      .filter((s) => !/\b\d{2}$/.test(s) || /\d{4}/.test(s)) // 2-digit years are ambiguous by design
      .concat([v.value]);
  }
  return [];
}

function localeOf(steps: Normalizer[] | undefined): string | undefined {
  for (const s of steps ?? []) if (typeof s === 'object' && 'locale' in s) return s.locale;
  return undefined;
}

/** The substring of `raw` that the pipeline reads (honours a leading extract step). */
function readSpan(raw: string, steps: Normalizer[] | undefined): string | undefined {
  const first = steps?.[0];
  if (first && typeof first === 'object' && first.op === 'extract') {
    const m = new RegExp(first.regex, stripGlobal(first.flags)).exec(raw);
    if (!m) return undefined;
    const g = first.group ?? (m.length > 1 ? 1 : 0);
    return typeof g === 'number' ? m[g] : m.groups?.[g];
  }
  return raw.trim();
}

function* valueAssertions(a: Assertion): Generator<Extract<Assertion, { kind: 'value' }>> {
  if (a.kind === 'value') yield a;
  if (a.kind === 'allOf' || a.kind === 'anyOf') for (const s of a.of) yield* valueAssertions(s);
}

function formattingVariants(cs: CheckSet, s: EvidenceSnapshot): Variant[] {
  const out: Variant[] = [];
  const idx = new AXIndex(s.a11y);
  for (const c of cs.checks) {
    for (const a of valueAssertions(c.assert)) {
      if (a.source.from !== 'node' || !localeOf(a.normalize)) continue;
      const r = resolveTarget(idx, a.source.target);
      if (!r.ok) continue;
      const raw = a.source.field === 'text' ? idx.text(r.node) : r.node.node[a.source.field];
      if (raw === undefined) continue;
      const span = readSpan(raw, a.normalize);
      if (!span) continue;
      let typed: TypedValue;
      try {
        typed = applyNormalizers({ type: 'string', value: raw }, a.normalize);
      } catch {
        continue;
      }
      for (const [i, alt] of formatsFor(typed, localeOf(a.normalize)!).entries()) {
        if (alt === span) continue;
        const target = r.node.id;
        const snap = editById(s, (n, id) => (id === target ? (replaceText(n, span, alt) ?? n) : undefined));
        out.push({
          id: `format:${c.id}:${i}`,
          description: `${c.id}'s value shown as ${JSON.stringify(alt)} instead of ${JSON.stringify(span)}`,
          snapshot: snap,
        });
      }
    }
  }
  return out;
}

export function generateVariants(cs: CheckSet, s: EvidenceSnapshot): Variant[] {
  const generic: [string, string, EvidenceSnapshot | null][] = [
    ['reorder', 'list items and table rows in reverse order', reorder(s)],
    ['extra-content', 'unrelated recommendations and a promotional status message on the page', extraContent(s)],
    ['extra-row', 'an unrelated extra row in each table', extraTableRow(s)],
    ['wrap-main', 'main content wrapped in an extra region', wrapMain(s)],
    ['spacing', 'non-breaking and doubled spaces in visible text', spacing(s)],
    ['extra-json-fields', 'extra fields in JSON bodies and probe results', extraJsonFields(s)],
    ['network-noise', 'an analytics beacon and repeated GET requests', networkNoise(s)],
    ['url-decoration', 'a tracking query parameter on the page URL', urlDecoration(s)],
  ];
  return [
    ...generic
      .filter((g): g is [string, string, EvidenceSnapshot] => g[2] !== null)
      .map(([id, description, snapshot]) => ({ id, description, snapshot })),
    ...formattingVariants(cs, s),
  ];
}
