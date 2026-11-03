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
  /** ARIA role, or "text" for a text run. The root is "document". */
  role: string;
  name?: string;
  value?: string;
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
  requestBody?: Json;
  responseHeaders: Record<string, string>;
  responseBody?: Json;
  bodyTruncated?: boolean;
  /** The response body should have been captured but could not be read. */
  bodyUnavailable?: boolean;
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
  | { from: 'storage'; area: 'cookie' | 'local' | 'session'; key: string; origin?: string }
  | { from: 'probe'; probe: string; pointer?: string };

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
  | { op: 'date'; locale: string; timezone?: string };

export interface Money {
  amount: number;
  currency: string;
}

export type Comparison =
  | { equals: Json }
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
}

export interface CheckSet {
  schema: typeof CHECKS_SCHEMA;
  id: string;
  version: string;
  task: { instruction: string; outcomes?: string };
  requirements: Requirement[];
  checks: Check[];
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
  | 'subcheck_abstained';

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
