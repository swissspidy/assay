/**
 * The mining-first compiler (ADR 0020): candidate checks generated mechanically from the
 * reference runs, evaluated as one batch of compiled plans over every reference, the baseline
 * and the stress variants, and ranked. No model runs here.
 *
 * The core rule of ADR 0002 holds by construction: a candidate compares evidence only with
 * values its requirement's quote names (words of the quote, an inflection of one quoted word,
 * a number or date the quote spells out, or a state word such as "checked"). Where evidence
 * is read (a probe and pointer, a request's method and path, a role) is not a condition and
 * comes from the references.
 */
import type {
  Assertion,
  CheckSet,
  EvidenceSnapshot,
  Json,
  JsonSchema,
  Normalizer,
  Requirement,
  StateExpect,
  Status,
  ValueSource,
} from '../types.ts';
import { CHECKS_SCHEMA, LANDMARK_ROLES } from '../types.ts';
import { canonical } from '../text.ts';
import { AXIndex, type INode } from '../runtime/axindex.ts';
import { compileChecks, PlanRun, runPlanMany } from '../plan/plan.ts';
import { buildStore } from '../store/store.ts';
import { generateVariants } from '../stress/variants.ts';
import { describeAssertion } from '../verifier/lock.ts';

/** How `compileTask` finds checks (ADR 0020). */
export type DiscoveryStrategy = 'model' | 'mine-first' | 'mine-only';

/** Where a candidate reads its evidence, in the trust order of ADR 0001 (highest first). */
export type CandidateFamily = 'probe' | 'storage' | 'network' | 'url' | 'a11y';

/** Rank of each family: structured evidence first (probes and storage, then the network, then the URL). */
export const FAMILY_TIER: Record<CandidateFamily, number> = { probe: 5, storage: 4, network: 3, url: 2, a11y: 1 };

export interface Candidate {
  id: string;
  requirement: string;
  family: CandidateFamily;
  assert: Assertion;
  description: string;
  /**
   * The candidate compares evidence with a value or state the quote names (not only
   * the presence of a request, a URL or a node): it can settle its requirement when no
   * baseline says the value was already there.
   */
  stated: boolean;
}

/** What one candidate did across the batch. */
export interface CandidateResult extends Candidate {
  /** Passes on every correct reference and every valid stress variant of them. */
  survives: boolean;
  /** Why it did not survive (the first failure seen). */
  rejected?: string;
  /** Incorrect references it does not pass on. */
  negativesRejected: string[];
  /** On the baseline (state before the task): `pass`, `fail`, or null when no baseline can tell. */
  baseline: 'pass' | 'fail' | null;
  /** Discrimination score: incorrect references rejected, plus one when the baseline fails it. */
  discrimination: number;
  /** Content words of the quote the candidate does not account for (see `evidenceWords`). */
  unexplained: string[];
  /** A survivor that can settle its requirement without the model (see `mineCandidates`). */
  decisive: boolean;
  /** Size of the assertion (JSON length): smaller is simpler. */
  size: number;
}

export interface MinedRequirement {
  requirement: string;
  quote: string;
  candidates: number;
  survivors: number;
  /** Ranked survivors that can settle the requirement, best first. */
  decisive: CandidateResult[];
  /** Ranked survivors that cannot settle it alone (seeds for the model), best first. */
  seeds: CandidateResult[];
}

export interface MineResult {
  candidates: CandidateResult[];
  requirements: MinedRequirement[];
  /** Variants evaluated (over all correct references). */
  variants: number;
  /** Wall time of generation and evaluation. */
  ms: number;
}

export interface MineInput {
  task: { id: string; instruction: string; outcomes?: string; skipVariants?: string[] };
  requirements: Requirement[];
  refs: { name: string; kind: 'success' | 'negative'; snapshot: EvidenceSnapshot }[];
  /** At most this many candidates per requirement and family (default 12). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// The quote: which values it names
// ---------------------------------------------------------------------------

const STOP = new Set(
  (
    'a an the to in on of at by for from with into onto as is are was were be been being it its this that these those ' +
    'then and or but so if my me i we our you your their his her them they he she there here what which who whom ' +
    'all any each every some no not only also again still yet just than too very can should must will would do does ' +
    'did done has have had get got make made put set let up out over under about after before new'
  ).split(' '),
);

/** Generic outcome verbs: a candidate need not account for them ("the subscription is saved"). */
const LIGHT = new Set(
  'saved stored exists exist contains contain updated changed created added called named titled now again add create change update'.split(
    ' ',
  ),
);

/** Quantifiers: a set, the rest of a collection or an absence, which a mined check does not express. */
const QUANT = new Set(
  'only every all each other others else everything nothing none longer except keep keeping stay stays'.split(' '),
);

/** Verbs that add to a collection, which keeps what it held (ADR 0011). */
const ADDS = new Set('add adds added adding put puts append appends insert inserts'.split(' '));

/** Words about what the page presents: accounted for by evidence read from the page (tree or URL). */
const PRESENT = new Set(
  'page pages show shows shown showing list lists listed display displays displayed visible see seen screen view checkbox button heading link tab field form menu'.split(
    ' ',
  ),
);

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

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

const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;

/** Lower-case word tokens of `s` (letters, digits and marks; punctuation and spacing are separators). */
export function tokens(s: string): string[] {
  return canonical(s).toLowerCase().match(TOKEN) ?? [];
}

/** A crude stem: common English suffixes removed, kept only when at least four letters remain. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ['ations', 'ation', 'ions', 'ion', 'ings', 'ing', 'ees', 'ee', 'ed', 'es', 'e', 'd']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
      w = w.slice(0, -suffix.length);
      // shipping → shipp → ship, wrapped → wrapp → wrap
      if (/([b-df-hj-np-rtv-z])\1$/.test(w) && !/(?:ss|ll|zz)$/.test(w)) w = w.slice(0, -1);
      break;
    }
  }
  if (w.endsWith('s') && !w.endsWith('ss') && w.length - 1 >= 4) w = w.slice(0, -1);
  return w;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** What a requirement's quote names: its words, their stems, numbers, dates and times. */
export class Quote {
  readonly text: string;
  readonly words: string[];
  private readonly wordSet: Set<string>;
  readonly numbers: Set<number>;
  /** Numbers written as `#n`: identifiers the quote names. */
  readonly ids: Set<number>;
  /** Dates the quote spells out, as yyyy-mm-dd. */
  readonly dates: Set<string>;
  /** Times the quote spells out, as HH:MM. */
  readonly times: Set<string>;
  /** The quote negates something ("not", "no longer", "un…", "remove"): booleans and states flip. */
  readonly negated: boolean;

  constructor(quote: string) {
    this.text = canonical(quote);
    this.words = tokens(quote);
    this.wordSet = new Set(this.words);
    this.numbers = new Set();
    for (const w of this.words) if (w in NUMBER_WORDS) this.numbers.add(NUMBER_WORDS[w]!);
    this.ids = new Set([...this.text.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])));
    this.dates = new Set();
    const lower = this.text.toLowerCase();
    const month = `(${MONTHS.join('|')})`;
    for (const m of lower.matchAll(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'g')))
      this.dates.add(`${m[3]}-${pad(MONTHS.indexOf(m[1]!) + 1)}-${pad(Number(m[2]))}`);
    for (const m of lower.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${month},?\\s+(\\d{4})\\b`, 'g')))
      this.dates.add(`${m[3]}-${pad(MONTHS.indexOf(m[2]!) + 1)}-${pad(Number(m[1]))}`);
    for (const m of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) this.dates.add(`${m[1]}-${m[2]}-${m[3]}`);
    this.times = new Set([...lower.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((m) => `${pad(Number(m[1]))}:${m[2]}`));
    // Numbers outside identifiers (#n), dates and times: a quantity, a price, a count.
    const plain = lower
      .replace(new RegExp(`\\b${month}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'g'), ' ')
      .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${month},?\\s+\\d{4}\\b`, 'g'), ' ')
      .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b|#\d+/g, ' ');
    for (const m of plain.matchAll(/(?<![\p{L}\d.])(\d+(?:\.\d+)?)(?![\p{L}\d])/gu)) this.numbers.add(Number(m[1]));
    this.negated =
      /\b(?:not|never|no longer|without|remove[sd]?|delete[sd]?|off)\b|n['’]t\b/i.test(this.text) ||
      this.words.some((w) => /^un[a-z]{3,}/.test(w) && !/^(?:under|until|unit|unique|universal)/.test(w));
  }

  /** The quote contains `words` as a contiguous run of its words (each the same word or an inflection). */
  private hasRun(words: string[]): boolean {
    return runAt(this.words, words) >= 0;
  }

  /** One word is a quoted word (not filler) or an inflection of one (close → closed, mug → mugs). */
  namesWord(word: string): boolean {
    const w = word.toLowerCase();
    if (STOP.has(w)) return false;
    return this.wordSet.has(w) || this.words.some((q) => !STOP.has(q) && sameWord(q, w));
  }

  /**
   * Whether the quote names the string `v` exactly: its words occur in the quote as a run
   * (case, punctuation, spacing and inflection aside) and are not only filler words, or it is
   * an ISO date (and time) the quote spells out.
   */
  namesString(v: string): boolean {
    const t = tokens(v);
    if (!t.length || t.length > 12 || t.every((w) => STOP.has(w))) return false;
    if (this.hasRun(t)) return true;
    return this.namesDate(v);
  }

  /** An ISO date or date-time whose date (and time, if any) the quote spells out. */
  namesDate(v: string): boolean {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/.exec(v);
    if (!m || !this.dates.has(m[1]!)) return false;
    return m[2] === undefined || this.times.has(m[2]);
  }

  /** Whether the quote names the number `n` (as digits or a number word; `#n` for identifiers). */
  namesNumber(n: number, idLike: boolean): boolean {
    return idLike ? this.ids.has(n) : this.numbers.has(n);
  }

  /**
   * The longest run of quoted words (not only filler) that occurs in `s`, as written in `s`
   * (so a name match is a substring of the name); or undefined.
   */
  runIn(s: string): string | undefined {
    const text = canonical(s);
    const spans = [...text.toLowerCase().matchAll(TOKEN)];
    const hay = spans.map((m) => m[0]);
    if (!hay.some((w) => this.namesWord(w))) return undefined;
    for (let len = Math.min(this.words.length, hay.length); len > 0; len--) {
      for (let i = 0; i + len <= this.words.length; i++) {
        const run = this.words.slice(i, i + len);
        if (run.every((w) => STOP.has(w))) continue;
        const at = runAt(hay, run);
        if (at < 0) continue;
        const from = spans[at]!;
        const to = spans[at + len - 1]!;
        return text.slice(from.index, to.index + to[0].length);
      }
    }
    return undefined;
  }

  /**
   * The words a candidate must account for: the quote's words without filler, generic outcome
   * verbs ("is saved", "exists") and the quantifiers mining cannot express (see `quantified`).
   */
  get content(): string[] {
    return [
      ...new Set(
        this.words.filter(
          (w) => !STOP.has(w) && !LIGHT.has(w) && !QUANT.has(w) && !/^\d+$/.test(w) && !(w in NUMBER_WORDS),
        ),
      ),
    ];
  }

  /** The numbers, identifiers, dates and times the quote states, as `evidenceWords` writes them. */
  get facts(): string[] {
    return [
      ...[...this.numbers, ...this.ids].map((n) => `#num:${n}`),
      ...[...this.dates].map((d) => `#date:${d}`),
      ...[...this.times].map((t) => `#time:${t}`),
    ].filter((x, i, xs) => xs.indexOf(x) === i);
  }

  /** The quote speaks of all, only, other or no longer: a set or an absence, which mining does not check. */
  get quantified(): boolean {
    return this.unquoted.some((w) => QUANT.has(w)) || this.adds;
  }

  /** The quote's words outside quotation marks (a quoted title such as "Add CSV export" is a name, not a verb). */
  private get unquoted(): string[] {
    return tokens(this.text.replace(/"[^"]*"|“[^”]*”/g, ' '));
  }

  /**
   * "Add X" (to a cart, a post's tags, a list) also keeps what the collection held before
   * (ADR 0011), a comparison with the baseline that mining does not build.
   */
  get adds(): boolean {
    return this.unquoted.some((w) => ADDS.has(w));
  }
}

/** The same word, or an inflection of it: a shared stem of four or more letters, or a plural `s`. */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (STOP.has(a) || STOP.has(b)) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long === `${short}s` && short.length >= 3) return true;
  const s = stem(a);
  return s.length >= 4 && s === stem(b);
}

/** Where `run` starts in `hay` (word by word, `sameWord`), or -1. */
function runAt(hay: string[], run: string[]): number {
  if (!run.length) return -1;
  outer: for (let i = 0; i + run.length <= hay.length; i++) {
    for (let j = 0; j < run.length; j++) if (!sameWord(hay[i + j]!, run[j]!)) continue outer;
    return i;
  }
  return -1;
}

/** Field names that identify a record rather than describe it: pinned only as `#n` or a quoted literal. */
const ID_KEY = /^(?:id|number|seq|uuid|key|ref|reference)$|(?:Id|_id|ID)$/;
/** Fields that name a record: a record in a collection is only told apart by one of these. */
const IDENT_KEY =
  /^(?:id|number|seq|uuid|key|ref|reference|title|name|subject|slug|username|login|email|sku|code|product|item|alias)$|(?:Id|_id|ID|Name|Title)$/;
/** Fields holding prose, matched give or take closing punctuation. */
const PROSE_KEY = /^(?:text|body|comment|message|content|description|note|excerpt|reply)s?$/i;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether every record a like-shape looks for in a collection is told apart by a field that
 * names it (an id, a title, a name): `{labels contains "bug"}` alone matches any such record,
 * not the one the quote means.
 */
function recordsIdentified(s: unknown): boolean {
  if (Array.isArray(s)) return s.every(recordsIdentified);
  if (!s || typeof s !== 'object') return true;
  const o = s as Record<string, unknown>;
  const inner = o.contains as Record<string, unknown> | undefined;
  if (inner && inner.type === 'object') {
    const props = (inner.properties ?? {}) as Record<string, Record<string, unknown>>;
    // A comment or message is told apart by its own words.
    const named = Object.entries(props).some(
      ([k, p]) => (IDENT_KEY.test(k) || PROSE_KEY.test(k)) && ('const' in p || 'pattern' in p),
    );
    if (!named) return false;
  }
  return Object.values(o).every(recordsIdentified);
}

/** A like-shape candidate states a value only when the records it looks for are identified. */
function identified(a: Assertion): boolean {
  if (a.kind === 'value' && 'schema' in a.expect) return recordsIdentified(a.expect.schema);
  if (a.kind === 'request') return recordsIdentified(a.match.requestBody) && recordsIdentified(a.match.responseBody);
  return true;
}

/** The words of a field name (camelCase, snake_case, kebab-case). */
const keyWords = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

// ---------------------------------------------------------------------------
// Like-shapes: JSON Schema keeping only the leaves the quote names
// ---------------------------------------------------------------------------

/** One leaf the quote names, at its JSON Pointer. */
interface NamedLeaf {
  pointer: string;
  value: Json;
}

const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const isObj = (v: Json | undefined): v is { [k: string]: Json } => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether the quote names the scalar `v` stored under field `key` (booleans: the field name is a quoted word). */
function namedScalar(q: Quote, key: string | undefined, v: Json): boolean {
  if (typeof v === 'string') return v.length <= 200 && q.namesString(v);
  if (typeof v === 'number') return Number.isFinite(v) && q.namesNumber(v, !!key && ID_KEY.test(key));
  if (typeof v === 'boolean')
    return !!key && keyWords(key).some((w) => q.namesWord(w)) && v === !q.negated && !ID_KEY.test(key);
  return false;
}

/**
 * The quote's leaves inside `v` as a JSON Schema "like" shape: objects keep the named fields
 * (all of them `required`), a named scalar becomes `const`, an array of scalars becomes
 * `contains` per named element, an array of records `contains` the record with the most named
 * fields (a whole record, never one field at a time). `prefer` picks which records count first
 * (e.g. those not in the baseline). Undefined when nothing is named.
 */
function likeShape(
  q: Quote,
  v: Json,
  key: string | undefined,
  depth: number,
  prefer?: (item: Json) => boolean,
): { schema: JsonSchema; leaves: number } | undefined {
  if (depth > 5) return undefined;
  if (v === null || typeof v !== 'object') {
    if (!namedScalar(q, key, v)) return undefined;
    // Prose (a comment, a message) as the quote words it, give or take closing punctuation.
    if (typeof v === 'string' && key && PROSE_KEY.test(key) && tokens(v).length >= 2) {
      const core = v.trim().replace(/[.!]$/, '');
      return { schema: { type: 'string', pattern: `^\\s*${escapeRegex(core)}[.!]?\\s*$` }, leaves: 1 };
    }
    return { schema: { const: v }, leaves: 1 };
  }
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) {
      const named = [...new Set(v.filter((x) => namedScalar(q, key, x)).map((x) => JSON.stringify(x)))].map(
        (x) => JSON.parse(x) as Json,
      );
      if (!named.length) return undefined;
      const contains = named.map((x) => ({ contains: { const: x } }));
      return {
        schema: contains.length === 1 ? { type: 'array', ...contains[0]! } : { type: 'array', allOf: contains },
        leaves: named.length,
      };
    }
    let best: { schema: JsonSchema; leaves: number; preferred: boolean } | undefined;
    for (const item of v) {
      const s = likeShape(q, item, key, depth + 1);
      if (!s) continue;
      const preferred = prefer ? prefer(item) : false;
      if (!best || (preferred && !best.preferred) || (preferred === best.preferred && s.leaves > best.leaves))
        best = { ...s, preferred };
    }
    return best ? { schema: { type: 'array', contains: best.schema }, leaves: best.leaves } : undefined;
  }
  const properties: Record<string, Json> = {};
  let leaves = 0;
  for (const [k, x] of Object.entries(v)) {
    const s = likeShape(q, x, k, depth + 1);
    if (!s) continue;
    properties[k] = s.schema as Json;
    leaves += s.leaves;
  }
  const keys = Object.keys(properties);
  if (!keys.length) return undefined;
  return { schema: { type: 'object', required: keys, properties }, leaves };
}

/** When a shape has a single named leaf on a path of object fields: its pointer and value (an `equals` reads simpler). */
function singleLeaf(schema: JsonSchema): NamedLeaf | undefined {
  let s = schema as { [k: string]: Json };
  let pointer = '';
  for (;;) {
    if ('const' in s) return { pointer, value: s.const! };
    if (s.type !== 'object') return undefined;
    const props = s.properties as Record<string, { [k: string]: Json }>;
    const keys = Object.keys(props);
    if (keys.length !== 1) return undefined;
    pointer += `/${esc(keys[0]!)}`;
    s = props[keys[0]!]!;
  }
}

const canon = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

const HEADING_LANDMARK = new Set<string>(['heading', ...LANDMARK_ROLES, 'dialog', 'alertdialog']);
const TEXT_ROLES = new Set(['status', 'alert', 'row', 'listitem', 'article']);
const CONTROLS = new Set([
  'checkbox',
  'switch',
  'radio',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'button',
]);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{32,36}|[A-Z0-9]{8,})$/;

/** State words of a quote, as a control's expected state (flipped by a negation). */
function statedState(q: Quote, role: string): StateExpect | undefined {
  const has = (...w: string[]) => w.some((x) => q.words.includes(x));
  const neg = q.negated;
  if (has('unchecked', 'unticked')) return { checked: false };
  if (has('checked', 'ticked')) return { checked: !neg };
  if (role === 'switch' && has('on')) return { checked: !neg };
  if (has('selected', 'chosen')) return { selected: !neg };
  if (has('pressed')) return { pressed: !neg };
  if (has('disabled')) return { disabled: !neg };
  if (has('enabled')) return { disabled: neg };
  return undefined;
}

interface Ref {
  name: string;
  snapshot: EvidenceSnapshot;
}

/** Items not deep-equal to an item of the same list in the baseline: the records the task added or changed. */
function newItems(before: Json | undefined): ((item: Json) => boolean) | undefined {
  if (!Array.isArray(before)) return undefined;
  const old = new Set(before.map(canon));
  return (item) => !old.has(canon(item));
}

const pointerGet = (v: Json | undefined, pointer: string): Json | undefined => {
  if (!pointer) return v;
  let cur = v;
  for (const raw of pointer.split('/').slice(1)) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) cur = cur[Number(k)];
    else if (isObj(cur)) cur = cur[k];
    else return undefined;
  }
  return cur;
};

/**
 * A like-shape (or `equals`) on a JSON value read from `source` in every correct reference;
 * the same in all of them, else nothing. `before` reads the baseline's value, to prefer records
 * the task added or changed.
 */
function jsonCandidate(
  q: Quote,
  values: (Json | undefined)[],
  befores: (Json | undefined)[],
  source: ValueSource,
  normalize: Normalizer[] | undefined,
): Assertion | undefined {
  let shape: string | undefined;
  let schema: JsonSchema | undefined;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === undefined) return undefined;
    // Records the task added or changed, wherever the value has a list of records.
    const prefer = Array.isArray(v) ? newItems(befores[i]) : undefined;
    const s = likeShape(q, v, sourceKey(source), 0, prefer);
    if (!s) return undefined;
    const c = canon(s.schema);
    if (shape !== undefined && c !== shape) return undefined;
    shape = c;
    schema = s.schema;
  }
  if (!schema) return undefined;
  const leaf = singleLeaf(schema);
  const base = 'pointer' in source && source.pointer ? source.pointer : '';
  if (leaf && (source.from === 'probe' || source.from === 'request' || source.from === 'response')) {
    const pointer = base + leaf.pointer;
    return {
      kind: 'value',
      source: { ...source, ...(pointer ? { pointer } : {}) } as ValueSource,
      ...(normalize ? { normalize } : {}),
      expect: { equals: leaf.value },
    };
  }
  if (leaf && leaf.pointer === '')
    return { kind: 'value', source, ...(normalize ? { normalize } : {}), expect: { equals: leaf.value } };
  return { kind: 'value', source, ...(normalize ? { normalize } : {}), expect: { schema } };
}

function sourceKey(s: ValueSource): string | undefined {
  if (s.from === 'storage') return s.key;
  if ((s.from === 'probe' || s.from === 'request' || s.from === 'response') && s.pointer)
    return s.pointer.split('/').at(-1);
  return s.from === 'probe' ? s.probe : undefined;
}

/** Top-level fields of a probe's value worth their own candidate (objects with records or settings). */
function probeSources(values: Json[]): string[] {
  const out = [''];
  if (values.every(isObj)) {
    const keys = Object.keys(values[0] as object).filter((k) => values.every((v) => k in (v as object)));
    for (const k of keys) {
      const x = (values[0] as Record<string, Json>)[k];
      if (x && typeof x === 'object') out.push(`/${esc(k)}`);
    }
  }
  return out;
}

function probeCandidates(q: Quote, refs: Ref[], push: (c: Omit<Candidate, 'id' | 'requirement'>) => void): void {
  const first = refs[0]!.snapshot;
  for (const name of Object.keys(first.probes ?? {}).toSorted()) {
    const results = refs.map((r) => r.snapshot.probes?.[name]);
    if (!results.every((p) => p?.ok)) continue;
    const values = results.map((p) => (p as { value: Json }).value);
    for (const pointer of probeSources(values)) {
      const source: ValueSource = { from: 'probe', probe: name, ...(pointer ? { pointer } : {}) };
      const vals = values.map((v) => pointerGet(v, pointer));
      const befores = refs.map((r) => {
        const b = r.snapshot.baseline?.probes[name];
        return b?.ok ? pointerGet(b.value, pointer) : undefined;
      });
      const a = jsonCandidate(q, vals, befores, source, undefined);
      if (a) push({ family: 'probe', assert: a, stated: identified(a), description: '' });
    }
  }
}

function storageCandidates(q: Quote, refs: Ref[], push: (c: Omit<Candidate, 'id' | 'requirement'>) => void): void {
  const first = refs[0]!.snapshot.storage;
  if (!first || refs.some((r) => !r.snapshot.storage)) return;
  for (const area of ['local', 'session'] as const) {
    for (const [origin, kv] of Object.entries(first[area]).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
      for (const key of Object.keys(kv).toSorted()) {
        const raws = refs.map((r) => r.snapshot.storage![area][origin]?.[key]);
        if (raws.some((x) => typeof x !== 'string')) continue;
        const source: ValueSource = { from: 'storage', area, key, origin };
        const strs = raws as string[];
        const parsed = strs.map((s) => {
          try {
            const j = JSON.parse(s) as Json;
            return j && typeof j === 'object' ? j : undefined;
          } catch {
            return undefined;
          }
        });
        let a: Assertion | undefined;
        if (parsed.every((p) => p !== undefined)) {
          const befores = refs.map((r) => {
            const b = r.snapshot.baseline?.storage?.[area][origin]?.[key];
            try {
              return typeof b === 'string' ? (JSON.parse(b) as Json) : undefined;
            } catch {
              return undefined;
            }
          });
          a = jsonCandidate(q, parsed, befores, source, ['json']);
        } else if (strs.every((s) => s === strs[0]) && namedScalar(q, key, strs[0]!)) {
          a = { kind: 'value', source, expect: { equals: strs[0]! } };
        }
        if (a) push({ family: 'storage', assert: a, stated: identified(a), description: '' });
      }
    }
  }
  const cookies = new Map<string, string[]>();
  for (const r of refs)
    for (const c of r.snapshot.storage!.cookies)
      if (typeof c.value === 'string') (cookies.get(c.name) ?? cookies.set(c.name, []).get(c.name)!).push(c.value);
  for (const [name, vs] of [...cookies].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    if (vs.length !== refs.length || vs.some((v) => v !== vs[0]) || !namedScalar(q, name, vs[0]!)) continue;
    push({
      family: 'storage',
      assert: { kind: 'value', source: { from: 'storage', area: 'cookie', key: name }, expect: { equals: vs[0]! } },
      stated: true,
      description: '',
    });
  }
}

/** A path pattern for a URL: identifier-like segments become `*`; `keep` decides which literal segments stay. */
function pathPattern(pathname: string, keep: (seg: string) => boolean): string {
  return pathname
    .split('/')
    .map((s, i) => {
      if (i === 0 || s === '') return s;
      let d = s;
      try {
        d = decodeURIComponent(s);
      } catch {
        /* raw */
      }
      return ID_SEGMENT.test(d) || !keep(d) ? '*' : d;
    })
    .join('/');
}

const segmentNamed = (q: Quote, seg: string) => tokens(seg).some((w) => q.namesWord(w)) || q.namesString(seg);

function networkCandidates(q: Quote, refs: Ref[], push: (c: Omit<Candidate, 'id' | 'requirement'>) => void): void {
  if (refs.some((r) => !r.snapshot.network)) return;
  // Mutating requests that succeeded, by method and path pattern, in every correct reference.
  const groups = refs.map((r) => {
    const m = new Map<string, { method: string; path: string; bodies: Json[]; responses: Json[] }>();
    for (const e of r.snapshot.network!) {
      if (!MUTATING.has(e.method) || e.status === null || e.status < 200 || e.status >= 400) continue;
      let u: URL;
      try {
        u = new URL(e.url);
      } catch {
        continue;
      }
      const path = pathPattern(u.pathname, () => true);
      const key = `${e.method} ${path}`;
      const g = m.get(key) ?? m.set(key, { method: e.method, path, bodies: [], responses: [] }).get(key)!;
      if (e.requestBody !== undefined && !e.requestBodyTruncated && !e.bodyTruncated) g.bodies.push(e.requestBody);
      if (e.responseBody !== undefined && !e.responseBodyTruncated && !e.bodyTruncated)
        g.responses.push(e.responseBody);
    }
    return m;
  });
  for (const [key, g] of [...groups[0]!].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    if (!groups.every((m) => m.has(key))) continue;
    const match = { method: g.method, url: { path: g.path }, status: { gte: 200, lt: 400 } };
    const named = g.path.split('/').some((s) => s !== '*' && s !== '' && segmentNamed(q, s));
    if (named) push({ family: 'network', assert: { kind: 'request', match }, stated: false, description: '' });
    // Bodies: a like-shape of the named fields, the same in every reference (one body each).
    for (const which of ['requestBody', 'responseBody'] as const) {
      const per = groups.map((m) => (which === 'requestBody' ? m.get(key)!.bodies : m.get(key)!.responses));
      if (per.some((b) => b.length !== 1)) continue;
      let shape: string | undefined;
      let schema: JsonSchema | undefined;
      for (const [body] of per) {
        const s = likeShape(q, body!, undefined, 0);
        if (!s || (shape !== undefined && canon(s.schema) !== shape)) {
          schema = undefined;
          shape = '!';
          break;
        }
        shape = canon(s.schema);
        schema = s.schema;
      }
      if (!schema) continue;
      const assert: Assertion = { kind: 'request', match: { ...match, [which]: schema } };
      push({ family: 'network', assert, stated: identified(assert), description: '' });
    }
  }
}

function urlCandidates(q: Quote, refs: Ref[], push: (c: Omit<Candidate, 'id' | 'requirement'>) => void): void {
  const paths: string[] = [];
  for (const r of refs) {
    try {
      paths.push(new URL(r.snapshot.page.url).pathname);
    } catch {
      return;
    }
  }
  const patterns = new Set(paths.map((p) => pathPattern(p, (s) => segmentNamed(q, s))));
  if (patterns.size !== 1) return;
  const path = [...patterns][0]!;
  if (!path.split('/').some((s) => s !== '' && s !== '*')) return;
  push({ family: 'url', assert: { kind: 'url', match: { path } }, stated: false, description: '' });
}

function a11yCandidates(q: Quote, refs: Ref[], push: (c: Omit<Candidate, 'id' | 'requirement'>) => void): void {
  const seen = new Map<string, { a: Assertion; stated: boolean; count: number }>();
  for (const r of refs) {
    const index = AXIndex.of(r.snapshot.a11y);
    const mine = new Set<string>();
    for (const n of index.all) {
      for (const c of nodeCandidates(q, index, n)) {
        const k = canon(c.a);
        if (mine.has(k)) continue;
        mine.add(k);
        const s = seen.get(k);
        if (s) s.count++;
        else seen.set(k, { ...c, count: 1 });
      }
    }
  }
  for (const s of seen.values())
    if (s.count === refs.length) push({ family: 'a11y', assert: s.a, stated: s.stated, description: '' });
}

function nodeCandidates(q: Quote, index: AXIndex, n: INode): { a: Assertion; stated: boolean }[] {
  const role = n.node.role;
  const out: { a: Assertion; stated: boolean }[] = [];
  const name = typeof n.node.name === 'string' ? canonical(n.node.name) : '';
  if (CONTROLS.has(role) && name) {
    const run = q.runIn(name);
    const state = statedState(q, role);
    if (run && state) {
      const exact = run.toLowerCase() === name.toLowerCase();
      out.push({
        a: {
          kind: 'state',
          target: { role, name: exact ? { equals: run, ignoreCase: true } : { contains: run, ignoreCase: true } },
          expect: state,
        },
        stated: true,
      });
    }
  }
  if (HEADING_LANDMARK.has(role) && name) {
    const run = q.runIn(name);
    if (run) {
      const exact = run.toLowerCase() === name.toLowerCase();
      out.push({
        a: {
          kind: 'contains',
          match: { role, name: exact ? { equals: run, ignoreCase: true } : { contains: run, ignoreCase: true } },
        },
        stated: false,
      });
    }
  } else if (TEXT_ROLES.has(role)) {
    const text = index.canonicalText(n);
    const run = text.length <= 300 ? q.runIn(text) : undefined;
    if (run)
      out.push({ a: { kind: 'contains', match: { role, text: { contains: run, ignoreCase: true } } }, stated: false });
  }
  return out;
}

/**
 * Typed candidate assertions for each requirement, from the correct references only, in the
 * trust order (probes, storage, network, URL, accessibility tree). Every value a candidate
 * compares is named by the requirement's quote.
 */
export function generateCandidates(
  requirements: Requirement[],
  refs: { name: string; kind: 'success' | 'negative'; snapshot: EvidenceSnapshot }[],
  limit = 12,
): Candidate[] {
  const ok = refs.filter((r) => r.kind === 'success');
  if (!ok.length) return [];
  const out: Candidate[] = [];
  for (const r of requirements) {
    const q = new Quote(r.source.quote);
    const seen = new Set<string>();
    const counts = new Map<CandidateFamily, number>();
    const push = (c: Omit<Candidate, 'id' | 'requirement'>) => {
      const k = canon(c.assert);
      const n = counts.get(c.family) ?? 0;
      if (seen.has(k) || n >= limit) return;
      seen.add(k);
      counts.set(c.family, n + 1);
      out.push({
        ...c,
        id: `${r.id}-mined-${seen.size}`,
        requirement: r.id,
        description: `Mined: ${describeAssertion(c.assert)}.`,
      });
    };
    probeCandidates(q, ok, push);
    storageCandidates(q, ok, push);
    networkCandidates(q, ok, push);
    urlCandidates(q, ok, push);
    a11yCandidates(q, ok, push);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a candidate accounts for
// ---------------------------------------------------------------------------

const STATE_WORDS: Record<string, string[]> = {
  checked: ['checked', 'unchecked', 'ticked', 'unticked', 'on', 'off'],
  selected: ['selected', 'chosen'],
  pressed: ['pressed'],
  disabled: ['disabled', 'enabled'],
};

/** The words a value stands for: its own, and for an ISO date the month, day and year it spells. */
function valueWords(v: Json): string[] {
  if (typeof v === 'number') return [`#num:${v}`];
  if (typeof v !== 'string') return [];
  const out = tokens(v);
  // Every number written in it ("305-555-0199" holds 305, 555 and 199, as the quote reads them).
  for (const m of v.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g)) out.push(`#num:${Number(m[0])}`);
  const t = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(v.trim());
  if (t) out.push(`#time:${t[1]!.padStart(2, '0')}:${t[2]}`);
  const d = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(v);
  if (d) {
    out.push(MONTHS[Number(d[2]) - 1] ?? '', `#date:${d[1]}-${d[2]}-${d[3]}`);
    if (d[4]) out.push(`#time:${d[4]}`);
  }
  return out;
}

const pathWords = (path: string | undefined) =>
  (path ?? '').split('/').flatMap((s) => (s === '*' || s === '**' ? [] : keyWords(decodeSafe(s))));

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function schemaWords(s: unknown, out: string[]): void {
  if (Array.isArray(s)) return s.forEach((x) => schemaWords(x, out));
  if (!s || typeof s !== 'object') return;
  for (const [k, v] of Object.entries(s)) {
    if (k === 'const') out.push(...valueWords(v as Json));
    else if (k === 'pattern' && typeof v === 'string')
      out.push(...tokens(v.replace(/\\[sdwbSDWB]|[\\^$.*+?()[\]{}|]/g, ' ')));
    else if (k === 'properties' && v && typeof v === 'object') {
      for (const [name, sub] of Object.entries(v)) {
        out.push(...keyWords(name));
        schemaWords(sub, out);
      }
    } else schemaWords(v, out);
  }
}

function sourceWords(src: ValueSource): string[] {
  switch (src.from) {
    case 'probe':
      return [...keyWords(src.probe), ...pathWords(src.pointer)];
    case 'storage':
      return keyWords(src.key);
    case 'request':
    case 'response':
      return [...pathWords(src.match.url?.path), ...pathWords(src.pointer)];
    default:
      return [];
  }
}

const matchWords = (m: unknown): string[] =>
  typeof m === 'string'
    ? tokens(m)
    : m && typeof m === 'object'
      ? tokens(
          String((m as { equals?: string; contains?: string }).equals ?? (m as { contains?: string }).contains ?? ''),
        )
      : [];

/**
 * The words a candidate's evidence stands for: the source it reads (probe, field and storage key
 * names, request and URL path segments, roles), the values it compares, its node's name and
 * its state words. A quote word another word here inflects is accounted for.
 */
export function evidenceWords(a: Assertion): string[] {
  const out: string[] = [];
  switch (a.kind) {
    case 'value':
      out.push(...sourceWords(a.source));
      if ('equals' in a.expect) out.push(...valueWords(a.expect.equals));
      if ('schema' in a.expect) schemaWords(a.expect.schema, out);
      break;
    case 'request':
      out.push(...pathWords(a.match.url?.path));
      schemaWords(a.match.requestBody, out);
      schemaWords(a.match.responseBody, out);
      break;
    case 'url':
      out.push(...pathWords(a.match.path));
      break;
    case 'state': {
      const t = 'role' in a.target ? a.target : undefined;
      if (t) out.push(t.role, ...matchWords(t.name));
      for (const k of Object.keys(a.expect)) out.push(...(STATE_WORDS[k] ?? []));
      break;
    }
    case 'contains':
      out.push(a.match.role, ...matchWords(a.match.name), ...matchWords(a.match.text));
      break;
    default:
      break;
  }
  return out.map((w) => w.toLowerCase()).filter(Boolean);
}

/** The content words of the quote a candidate does not account for (words about the page need page evidence). */
function unaccounted(q: Quote, c: Candidate): string[] {
  const ev = evidenceWords(c.assert);
  const onPage = c.family === 'a11y' || c.family === 'url';
  const out: string[] = [];
  for (const w of q.content) {
    if (PRESENT.has(w) && onPage) continue;
    // A word the quote uses twice ("the Dentist event is called Dentist (Dr. Lee)") names two
    // things; the evidence must account for each use, or one of them is left unchecked.
    const need = q.words.filter((x) => x === w).length;
    const have = ev.filter((e) => sameWord(e, w)).length;
    if (have === 0 || (need > 1 && have < need)) out.push(w);
  }
  // Numbers, identifiers, dates and times the quote states must be among the values compared.
  for (const f of q.facts) if (!ev.includes(f)) out.push(f.slice(f.indexOf(':') + 1));
  return out;
}

// ---------------------------------------------------------------------------
// Batch evaluation and ranking
// ---------------------------------------------------------------------------

/** Best first: discrimination, then trust (family tier), then simplicity (assertion size). */
export function rankCandidates<T extends Pick<CandidateResult, 'discrimination' | 'family' | 'size' | 'id'>>(
  xs: T[],
): T[] {
  return xs.toSorted(
    (a, b) =>
      b.discrimination - a.discrimination ||
      FAMILY_TIER[b.family] - FAMILY_TIER[a.family] ||
      a.size - b.size ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The snapshot as it was before the task, for the parts a baseline records (probes, storage, URL). */
function baselineView(s: EvidenceSnapshot): EvidenceSnapshot | undefined {
  const b = s.baseline;
  if (!b) return undefined;
  return { ...s, page: { ...s.page, url: b.url }, probes: b.probes, storage: b.storage };
}

/**
 * Generate candidates and evaluate them all as one compiled plan: on every reference
 * (`runPlanMany`, stores built once), on every valid stress variant of the correct ones
 * (overlays on the reference's run, ADR 0016), and on the baseline. Then rank the survivors.
 */
export function mineCandidates(input: MineInput): MineResult {
  const t0 = performance.now();
  const { task, requirements, refs } = input;
  const candidates = generateCandidates(requirements, refs, input.limit);
  const pool: CheckSet = {
    schema: CHECKS_SCHEMA,
    id: task.id,
    version: '1',
    task: { instruction: task.instruction, ...(task.outcomes !== undefined ? { outcomes: task.outcomes } : {}) },
    requirements,
    checks: candidates.map((c) => ({
      id: c.id,
      requirement: c.requirement,
      description: c.description,
      assert: c.assert,
    })),
  };
  const n = candidates.length;
  const alive = Array.from({ length: n }, () => true);
  const why: (string | undefined)[] = Array.from({ length: n });
  const negatives: string[][] = candidates.map(() => []);
  const baseline: ('pass' | 'fail' | null)[] = candidates.map(() => null);
  let variantCount = 0;
  if (n) {
    const plan = compileChecks(pool);
    const stores = refs.map((r) => buildStore(r.snapshot));
    const outcomes = runPlanMany(plan, stores, { digests: false });
    refs.forEach((r, j) => {
      outcomes[j]!.checks.forEach((c, i) => {
        if (r.kind === 'success') {
          if (alive[i] && c.status !== 'pass') {
            alive[i] = false;
            why[i] = `${c.status}s on correct run "${r.name}": ${c.message}`;
          }
        } else if (c.status !== 'pass') negatives[i]!.push(r.name);
      });
    });
    const skip = new Set(task.skipVariants ?? []);
    refs.forEach((r, j) => {
      if (r.kind !== 'success') return;
      const base = new PlanRun(plan, stores[j]!);
      for (const v of generateVariants(pool, r.snapshot)) {
        if (skip.has(v.id.split(':')[0]!)) continue;
        variantCount++;
        const run = new PlanRun(plan, buildStore(v.snapshot), base);
        for (let i = 0; i < n; i++) {
          if (!alive[i]) continue;
          const s: Status = run.check(i).status;
          if (s !== 'pass') {
            alive[i] = false;
            why[i] = `${s}s on valid variant ${v.id} of "${r.name}" (${v.description})`;
          }
        }
      }
    });
    // The baseline: only probes, storage and the URL were recorded before the task.
    const views = refs.filter((r) => r.kind === 'success').map((r) => baselineView(r.snapshot));
    if (views.length && views.every((v) => v !== undefined)) {
      const before = runPlanMany(
        plan,
        views.map((v) => buildStore(v!)),
        { digests: false },
      );
      candidates.forEach((c, i) => {
        if (c.family !== 'probe' && c.family !== 'storage' && c.family !== 'url') return;
        const st = before.map((o) => o.checks[i]!);
        if (st.some((x) => x.status === 'abstain' && x.reason === 'evidence_unavailable')) return;
        baseline[i] = st.every((x) => x.status === 'pass') ? 'pass' : 'fail';
      });
    }
  }
  const quotes = new Map(requirements.map((r) => [r.id, new Quote(r.source.quote)]));
  const results: CandidateResult[] = candidates.map((c, i) => {
    const q = quotes.get(c.requirement)!;
    const discrimination = negatives[i]!.length + (baseline[i] === 'fail' ? 1 : 0);
    const unexplained = unaccounted(q, c);
    // Settles its requirement: it accounts for every content word of a quote mining can
    // express, and either rejects an incorrect reference, or compares a value the quote names
    // that the baseline (when there is one) did not already hold.
    const decisive =
      alive[i]! &&
      !q.quantified &&
      !unexplained.length &&
      (negatives[i]!.length > 0 || (c.stated && baseline[i] !== 'pass'));
    return {
      ...c,
      survives: alive[i]!,
      ...(why[i] ? { rejected: why[i] } : {}),
      negativesRejected: negatives[i]!,
      baseline: baseline[i]!,
      discrimination,
      unexplained,
      decisive,
      size: canon(c.assert).length,
    };
  });
  const perReq: MinedRequirement[] = requirements.map((r) => {
    const mine = results.filter((c) => c.requirement === r.id);
    const ranked = rankCandidates(mine.filter((c) => c.survives));
    return {
      requirement: r.id,
      quote: r.source.quote,
      candidates: mine.length,
      survivors: ranked.length,
      decisive: ranked.filter((c) => c.decisive),
      seeds: ranked.filter((c) => !c.decisive),
    };
  });
  return { candidates: results, requirements: perReq, variants: variantCount, ms: performance.now() - t0 };
}

/**
 * Pick checks from the ranked survivors: the best decisive candidate per requirement (minus
 * `exclude`), then, for each incorrect reference the picks would still judge a success, the
 * best-ranked survivor that rejects it. Requirements without a decisive survivor are open.
 */
export function selectMined(
  mined: MineResult,
  requirements: Requirement[],
  refs: { name: string; kind: 'success' | 'negative' }[],
  exclude: ReadonlySet<string> = new Set(),
): { picks: CandidateResult[]; open: string[] } {
  const picks: CandidateResult[] = [];
  const open: string[] = [];
  for (const r of mined.requirements) {
    const best = r.decisive.find((c) => !exclude.has(c.id));
    if (best) picks.push(best);
    else open.push(r.requirement);
  }
  const hard = new Set(requirements.filter((r) => r.kind === 'hard').map((r) => r.id));
  for (const neg of refs.filter((r) => r.kind === 'negative')) {
    const rejected = picks.some((p) => hard.has(p.requirement) && p.negativesRejected.includes(neg.name));
    if (rejected) continue;
    const covered = new Set(picks.map((p) => p.requirement));
    const extra = rankCandidates(
      mined.candidates.filter(
        (c) =>
          c.survives &&
          !exclude.has(c.id) &&
          hard.has(c.requirement) &&
          covered.has(c.requirement) &&
          c.negativesRejected.includes(neg.name) &&
          !picks.includes(c),
      ),
    )[0];
    if (extra) picks.push(extra);
  }
  // In requirement order, then rank order, so the set reads like a compiled one.
  const order = new Map(requirements.map((r, i) => [r.id, i]));
  return {
    picks: picks.toSorted((a, b) => order.get(a.requirement)! - order.get(b.requirement)!),
    open,
  };
}
