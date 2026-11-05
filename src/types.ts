/**
 * Core types for Assay. See docs/adr/0001-evidence-snapshot-and-check-dsl.md.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------
// Evidence snapshot (assay.snapshot/v1)
// ---------------------------------------------------------------------------

export const SNAPSHOT_SCHEMA = 'assay.snapshot/v1' as const;

export interface AXStates {
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
}

export interface AXNode {
  /**
   * ARIA role, or "text" for a text run. The root is "document". An `iframe` node holds
   * the content of its frame as children (ADR 0012).
   */
  role: string;
  name?: string;
  value?: string;
  /** A link's target; for an `iframe`, the URL of the document in the frame. */
  url?: string;
  level?: number;
  states?: AXStates;
  props?: Record<string, string>;
  children?: AXNode[];
}

export interface NetworkEntry {
  seq: number;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failure?: string;
  requestHeaders: Record<string, string>;
  /**
   * Parsed JSON; a form body (URL-encoded or multipart) as an object of its fields
   * (repeated fields become arrays, a file becomes `{filename, type, size}`); else text.
   */
  requestBody?: Json;
  /**
   * The text of a form body as sent, when `requestBody` holds its parsed fields. The
   * content of multipart file parts is left out.
   */
  requestBodyRaw?: string;
  /** The request carried a body (it has a content type) that could not be read. */
  requestBodyUnavailable?: boolean;
  responseHeaders: Record<string, string>;
  responseBody?: Json;
  bodyTruncated?: boolean;
  /** The response body should have been captured but could not be read. */
  bodyUnavailable?: boolean;
}

/** What one open page (tab or popup) showed at capture time. */
export interface PageView {
  url: string;
  title: string;
  a11y: AXNode;
  /** innerText of the body, followed by the text of each captured frame. */
  text: string;
  /** The page could not be read (it hung or crashed); its a11y and text are empty. */
  unavailable?: true;
}

/** A file in a multipart form body: its metadata, never its content. */
export interface FormFile {
  filename: string;
  type: string;
  size: number;
}

export interface Redacted {
  redacted: true;
}

export interface CookieRecord {
  name: string;
  value: string | Redacted;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
}

export interface StorageRecord {
  cookies: CookieRecord[];
  /** origin -> key -> value */
  local: Record<string, Record<string, string | Redacted>>;
  session: Record<string, Record<string, string | Redacted>>;
}

export type ProbeResult = { ok: true; value: Json } | { ok: false; error: string };

/**
 * State captured before the agent started (see captureBaseline). Checks read it
 * with `at: "before"` on a probe or storage source.
 */
export interface Baseline {
  /** Metadata only, never read by checks (excluded from the digest). */
  capturedAt: string;
  /** URL of the page when the baseline was captured. */
  url: string;
  /** null = storage was not captured. */
  storage: StorageRecord | null;
  probes: Record<string, ProbeResult>;
  /** Values redacted in this baseline, as in `meta.redacted`. */
  redacted: string[];
}

export interface EvidenceSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  capturedAt: string;
  page: { url: string; title: string };
  a11y: AXNode;
  text: string;
  /** null = network was not recorded. */
  network: NetworkEntry[] | null;
  /** null = storage was not captured. */
  storage: StorageRecord | null;
  probes: Record<string, ProbeResult>;
  /** State before the agent started; absent = no baseline was captured. */
  baseline?: Baseline;
  /**
   * The other open pages of the browser context (tabs, popups), in the order they were
   * opened; absent when the active page was the only one. `page`, `a11y` and `text`
   * describe the active page (ADR 0012).
   */
  pages?: PageView[];
  meta: { capturer: string; redacted: string[] };
}

// ---------------------------------------------------------------------------
// Check DSL (assay.checks/v1)
// ---------------------------------------------------------------------------

export const CHECKS_SCHEMA = 'assay.checks/v1' as const;

export type TextMatch =
  | string
  | { equals: string; ignoreCase?: boolean }
  | { contains: string; ignoreCase?: boolean }
  | { regex: string; flags?: string };

export const LANDMARK_ROLES = [
  'banner',
  'complementary',
  'contentinfo',
  'form',
  'main',
  'navigation',
  'region',
  'search',
] as const;
export type LandmarkRole = (typeof LANDMARK_ROLES)[number];

export interface Locator {
  role: string;
  name?: TextMatch;
  text?: TextMatch;
  level?: number;
  landmark?: { role: LandmarkRole; name?: TextMatch };
  within?: Locator;
  /**
   * For a cell (cell, gridcell, rowheader, columnheader): the name of its column's header,
   * the columnheader at the same position in the table's header row (ADR 0008).
   */
  column?: TextMatch;
}

export type Target = Locator | { anchors: Locator[] };

export interface NumberCompare {
  eq?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface UrlMatch {
  /** Path pattern: literal segments, ":name" or "*" for one segment, trailing "**" for any suffix. */
  path?: string;
  /** Regex tested against the full href. */
  regex?: string;
  origin?: string;
  /** null = the parameter must be absent. */
  query?: Record<string, TextMatch | null>;
}

/** Selects one open page of a snapshot by its URL and/or title (ADR 0012). */
export interface PageMatch {
  url?: UrlMatch;
  title?: TextMatch;
}

export type JsonSchema = { [key: string]: Json } | boolean;

export interface RequestMatch {
  method?: string | string[];
  url?: UrlMatch;
  status?: number | NumberCompare;
  requestBody?: JsonSchema;
  responseBody?: JsonSchema;
}

export type ValueSource =
  | { from: 'node'; target: Target; field: 'name' | 'value' | 'text' | 'url' }
  | { from: 'text'; scope?: Target; pattern: string; flags?: string; group?: number | string }
  | { from: 'url'; part: 'href' | 'origin' | 'pathname' | 'search' | 'hash' | { param: string } }
  | { from: 'request' | 'response'; match: RequestMatch; pointer?: string; pick?: 'only' | 'first' | 'last' }
  | { from: 'storage'; area: 'cookie' | 'local' | 'session'; key: string; origin?: string; at?: Moment }
  | { from: 'probe'; probe: string; pointer?: string; at?: Moment };

/** When a probe or storage value was read: at the end of the run (default) or from the baseline. */
export type Moment = 'after' | 'before';

export type Normalizer =
  | 'trim'
  | 'collapseWhitespace'
  | 'lowercase'
  | 'uppercase'
  | 'nfkc'
  | 'stripDiacritics'
  | 'json'
  | 'boolean'
  | { op: 'trim' | 'collapseWhitespace' | 'lowercase' | 'uppercase' | 'nfkc' | 'stripDiacritics' | 'json' | 'boolean' }
  | { op: 'extract'; regex: string; flags?: string; group?: number | string }
  | { op: 'replace'; regex: string; flags?: string; with: string }
  | { op: 'number'; locale: string }
  | { op: 'currency'; locale: string; currency?: string }
  | { op: 'date'; locale: string; timezone?: string }
  | { op: 'datetime'; locale: string; timezone?: string }
  /**
   * A JSON array as an unordered collection: keep items matching `where`, map each to the
   * value at `pointer` (or to an object of the fields at the `pick` pointers, keyed by
   * pointer, so they stay paired), sort. With `flatten`, the value at `pointer` is itself
   * an array (a record's tags or labels) and its elements become the items, so one
   * record's collection can be compared member by member (ADR 0011).
   */
  | { op: 'items'; where?: JsonSchema; pointer?: string; pick?: string[]; flatten?: boolean };

export interface Money {
  amount: number;
  currency: string;
}

/** The other side of a binding: a value read from another source and normalized on its own. */
export interface Operand {
  source: ValueSource;
  normalize?: Normalizer[];
}

export type Comparison =
  | { equals: Json }
  | { sameAs: Operand }
  | { oneOf: Json[] }
  | { contains: string; ignoreCase?: boolean }
  | { regex: string; flags?: string }
  | { approx: { value: number | string | Money; abs?: number; rel?: number } }
  | {
      gt?: number | string | Money;
      gte?: number | string | Money;
      lt?: number | string | Money;
      lte?: number | string | Money;
    }
  | { schema: JsonSchema }
  | { exists: true };

export interface StateExpect {
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  level?: number;
  name?: TextMatch;
  value?: TextMatch;
  text?: TextMatch;
}

export type Assertion =
  | { kind: 'state'; target: Target; expect: StateExpect }
  | {
      kind: 'contains';
      scope?: Target;
      /** Outcome-independent node that must exist inside the scope (e.g. a header row); missing → abstain. */
      witness?: Locator;
      match: Locator;
      count?: NumberCompare;
    }
  | { kind: 'value'; source: ValueSource; normalize?: Normalizer[]; expect: Comparison }
  | { kind: 'url'; match: UrlMatch }
  | { kind: 'request'; match: RequestMatch; count?: NumberCompare }
  /**
   * Per record: every node matching `match` inside `scope` is a record (a row, a list item, an
   * article; a term together with the definitions that follow it), and `assert` must hold
   * inside each one. Locators and text sources in `assert` resolve within the record.
   * `count` bounds how many records match (default `{gte: 1}`).
   */
  | {
      kind: 'each';
      scope?: Target;
      /** Outcome-independent node that must exist inside the scope; missing → abstain. */
      witness?: Locator;
      match: Locator;
      count?: NumberCompare;
      assert: Assertion;
    }
  /**
   * On one open page: `assert` reads the page (tab, popup) that `match` selects instead of
   * the active page. No such page, or several → abstain (ADR 0012).
   */
  | { kind: 'page'; match: PageMatch; assert: Assertion }
  | { kind: 'allOf'; of: Assertion[] }
  | { kind: 'anyOf'; of: Assertion[] };

export interface Requirement {
  id: string;
  kind: 'hard' | 'soft';
  text: string;
  source: { field: 'instruction' | 'outcomes'; quote: string };
}

export interface Check {
  id: string;
  requirement: string;
  description: string;
  assert: Assertion;
  /**
   * What escalation does when this check fails (ADR 0004): "escalate" sends the
   * failed requirement to the verifier, "keep" keeps the failure. Unset follows
   * the escalation policy (`policy.on`).
   */
  onFail?: 'escalate' | 'keep';
  /**
   * What the check concludes when the evidence of one way of doing the task is
   * missing (ADR 0011). Unset or "fail": a missing request or a page URL that does
   * not match fails, as an observed absence. "abstain": the check reads route
   * evidence (the requests one UI sends, the URL it passes through), so a run that
   * took another route has nothing for it to read; it abstains with reason
   * `route_missing`, and inside an `anyOf` such a branch gives way to the branches
   * whose route was taken. Evidence that was found but is wrong still fails.
   */
  onMissing?: 'fail' | 'abstain';
}

/** Provenance of a compiled check set. */
export interface Provenance {
  /** The compiler, as "assay/<version>". */
  compiler: string;
  /** The model client the compiler was given, e.g. "anthropic:claude-opus-5-5@high". */
  model: string;
  /** The models that actually served the turns, as the API reported them. */
  modelsUsed: string[];
  /** When the model was run (ISO 8601). A replayed compile keeps the recording's time. */
  at: string;
}

export interface CheckSet {
  schema: typeof CHECKS_SCHEMA;
  id: string;
  version: string;
  task: { instruction: string; outcomes?: string };
  requirements: Requirement[];
  checks: Check[];
  /** Where a compiled set came from; absent on handwritten sets. */
  compiled?: Provenance;
  /** Set by human confirmation (lockCheckSet); the digest covers everything else in the set. */
  locked?: { by: string; at: string; digest: string };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type Status = 'pass' | 'fail' | 'abstain';

export type AbstainReason =
  | 'anchor_missing'
  | 'anchor_ambiguous'
  | 'anchor_conflict'
  | 'evidence_unavailable'
  | 'probe_error'
  | 'value_unavailable'
  | 'value_ambiguous'
  | 'normalize_failed'
  | 'type_mismatch'
  | 'uncovered'
  | 'subcheck_abstained'
  /**
   * A check with `onMissing: "abstain"` found no evidence of the route it reads (no
   * matching request, a URL elsewhere): the run may have done the task another way.
   */
  | 'route_missing'
  /** The agentic verifier could not observe enough to decide (escalation). */
  | 'verifier_unknown';

export type Channel = 'a11y' | 'text' | 'url' | 'network' | 'storage' | 'probe';
export type Trust = 'structured' | 'semantic' | 'freetext';

export const CHANNEL_TRUST: Record<Channel, Trust> = {
  probe: 'structured',
  network: 'structured',
  storage: 'structured',
  url: 'structured',
  a11y: 'semantic',
  text: 'freetext',
};

export interface Evidence {
  channel: Channel;
  trust: Trust;
  origin: 'observed';
  locator?: string;
  value?: Json;
}

/** Result of evaluating one assertion (possibly nested). */
export interface AssertionResult {
  status: Status;
  reason?: AbstainReason;
  message: string;
  evidence: Evidence[];
  drift: string[];
}

export interface CheckResult extends AssertionResult {
  check: string;
  requirement: string;
  description: string;
}

export interface RequirementResult {
  requirement: string;
  kind: 'hard' | 'soft';
  text: string;
  status: Status;
  reason?: AbstainReason;
  checks: string[];
  /** Set after escalation: who decided this requirement. */
  decidedBy?: 'checks' | 'verifier';
  /** Observations the verifier cited when it decided this requirement. */
  verifierEvidence?: string[];
}

export type Verdict = 'success' | 'fail' | 'abstain';

export interface Outcome {
  verdict: Verdict;
  checkSet: { id: string; version: string; digest: string };
  snapshot: { digest: string; url: string; capturedAt: string };
  requirements: RequirementResult[];
  checks: CheckResult[];
  /** Anchors that matched nothing but did not prevent a decision. */
  drift: { check: string; locator: string }[];
}
