# ADR 0001: Evidence snapshot format and check DSL

- Status: Accepted
- Date: 2026-11-02
- Scope: Milestone 1 (snapshot format, check DSL, runtime)

## Context

Assay checks whether a web agent actually completed a task. A model checks a
reference run once, at authoring time. The result is compiled into
deterministic checks that later run in milliseconds, with no model. The
compiler, stress tester, escalation path and evaluation (milestones 2-5) are
all built on two formats:

1. The **evidence snapshot**: a serializable record of what could be observed
   after a run.
2. The **check DSL**: declarative JSON that says which evidence decides each
   requirement.

These formats must meet these constraints:

- **Data, not code.** Checks are JSON. A model can emit them, a JSON Schema
  can validate them, people can review them in plain language, and they can be
  versioned and locked. Checks contain no JavaScript, no CSS selectors and
  no XPath.
- **Same semantics live and offline.** A check gives the same result on a live
  page and on a snapshot captured from that page. Stress testing (milestone 3) depends on this, because it mutates snapshots rather than driving a
  browser.
- **Three outcomes.** Each check returns `pass`, `fail` or `abstain`. Abstain
  means "I cannot decide", and it is what triggers escalation (milestone 4).
  If abstain fires too rarely, wrong verdicts become silent. If it fires too
  often, the expensive verifier runs all the time. The boundary has to be
  principled.
- **No condition the task didn't state.** VerifierBench found that generated
  verifiers mostly go wrong by rejecting valid solutions. Every check is
  therefore traced to a requirement, and every requirement to instruction
  text. The DSL makes the permissive form the easy one to write: normalizers,
  tolerances and `contains` instead of exact string equality.
- **Structured evidence first.** Visible text is the easiest evidence for a
  manipulated or confused page to fake ("Order placed!"). Network responses,
  accessibility state, storage and backend probes are harder to fake.
- **Deterministic.** Running a check never reads the clock, the host locale,
  the timezone or the network. Locale and timezone are parameters of a check.

## Decision

### 1. Evidence snapshot (`assay.snapshot/v1`)

A snapshot is a single JSON document:

```jsonc
{
  "schema": "assay.snapshot/v1",
  "capturedAt": "2026-11-02T10:00:00.000Z",  // metadata only, never read by checks
  "page":    { "url": "http://shop.test/orders/A1", "title": "Order A1" },
  "a11y":    { "role": "document", "children": [ /* AXNode */ ] },
  "text":    "Order confirmed\nOrder #A1 ...",   // document.body.innerText
  "network": [ /* NetworkEntry */ ] | null,      // null = not recorded
  "storage": { "cookies": [...], "local": {...}, "session": {...} } | null,
  "probes":  { "latestOrder": { "ok": true, "value": { ... } } },
  "meta":    { "capturer": "assay/0.1.0", "redacted": ["cookie:sid"] }
}
```

**Channels.** Each top-level key is an evidence channel, ranked by trust:

| Channel    | Trust      | Source                                                                |
| ---------- | ---------- | --------------------------------------------------------------------- |
| `probes`   | structured | User-supplied read-only backend adapters (HTTP API, DB query)         |
| `network`  | structured | Requests and responses recorded on the browser context from its start |
| `storage`  | structured | Cookies, `localStorage`, `sessionStorage` of the page's origin        |
| `page.url` | structured | Final URL of the main frame                                           |
| `a11y`     | semantic   | Accessibility tree of the main frame                                  |
| `text`     | free text  | `innerText` of the body; trivially spoofable                          |

`null` means the channel was **not captured**. That is different from
"captured and empty" (`[]`, `{}`). A check that needs a missing channel
abstains. It never fails.

**Accessibility tree.** We build `a11y` from Playwright's
`locator.ariaSnapshot()` and parse it into a tree:

```ts
interface AXNode {
  role: string; // ARIA role, or "text" for text runs
  name?: string; // accessible name (whitespace-normalized)
  value?: string; // textbox/searchbox/spinbutton/slider/combobox value
  url?: string; // link target (/url)
  level?: number; // heading level
  states?: {
    checked?: boolean | 'mixed';
    pressed?: boolean | 'mixed';
    selected?: boolean;
    expanded?: boolean;
    disabled?: boolean;
  };
  props?: Record<string, string>; // other /key: value properties
  children?: AXNode[];
}
```

We use `ariaSnapshot()` rather than CDP `Accessibility.getFullAXTree` for
three reasons. It works in every browser, it applies the same role and
name computation as `getByRole` (so a handwritten check means what a
Playwright user expects), and it drops unnamed `generic` wrappers. Those
wrappers churn whenever the markup changes, so dropping them makes anchors
more stable. The cost is lower fidelity. `aria-expanded="false"` and an
absent `aria-expanded` look the same, so a missing state means `false`.
Hidden content and `aria-hidden` content are excluded, which is what we
want: checks only see what a user or assistive technology can perceive.

A node's **text** is not stored. It is derived as the space-joined text of
its descendants (text runs, plus names of leaf nodes). Deriving it keeps
mutations consistent: editing a cell's name updates its row's text too.

**Network log.** An `EvidenceRecorder` attaches to the `BrowserContext`
before the agent runs, so it sees every request.

```ts
interface NetworkEntry {
  seq: number; // order of request start
  method: string;
  url: string;
  resourceType: string;
  status: number | null; // null = no response (failed, aborted or in flight)
  failure?: string;
  requestHeaders: Record<string, string>; // allowlisted: content-type, accept
  requestBody?: Json | string | null; // parsed JSON when content-type is JSON
  responseHeaders: Record<string, string>; // allowlisted: content-type, location
  responseBody?: Json | string | null;
  bodyTruncated?: boolean;
  bodyUnavailable?: boolean; // a body should exist but could not be read
}
```

Request bodies are always kept. Response bodies are kept only for `fetch`
and `xhr` with text or JSON content types, up to a size cap. Document HTML
is implementation noise, and the `a11y` and `text` channels already cover
what the page shows. Authorization and cookie headers are never
recorded.

**Response bodies and navigation.** Chromium discards a response's body as
soon as the page navigates. A common flow is "POST /api/orders, then
`location.href = '/orders/A1'`", and in that flow the protocol-level read
(`response.body()`) fails. Milestone 1 tests hit this. The recorder
therefore also installs an init script that tees `fetch` and `XHR` response
bodies (`Response.clone()`) to a Playwright binding. Integrity rules:

- Every tap message carries a random token that lives only in the init
  script's closure. Page scripts can find the binding, but they can't forge
  a message without the token.
- The tap **only fills in bodies** of entries the browser itself reported.
  It never creates entries, so a page can't invent a request.
- A protocol-read body takes precedence over a tapped one.
- If neither path produced a body that should exist, the entry is marked
  `bodyUnavailable`.

**Request matching is three-valued.** An entry matches a `RequestMatch` with
`yes`, `no` or `unknown`. It is `unknown` when the entry could match but the
deciding evidence is missing: a truncated or unavailable body, or a status
still in flight. A `request` check knows the true count lies in
`[yes, yes + unknown]`. It decides only if both ends give the same answer,
and abstains otherwise. A missing body therefore never turns into a false
`fail`, and never into a false `pass` for absence checks.

**Storage.** By default, values of `httpOnly` cookies are replaced with
`{"redacted": true}` and listed in `meta.redacted`. Snapshots end up in audit
records, and session tokens don't belong there. A check that reads a redacted
value abstains (`evidence_unavailable`).

**Probes.** A probe is a named, read-only function supplied by the user at
capture time (`() => Promise<Json>`). The snapshot stores its result
(`{ok, value}` or `{ok:false, error}`). Checks refer to probes by name only,
so the check set stays data. The adapter is code, but it lives with the
environment, not with the checks.

**Digest.** `sha256` of the canonical JSON (sorted keys, no whitespace) of the
snapshot with `capturedAt` removed. Outcome records cite this digest.

**Scope limits of v1.** Main frame only: no iframes, no shadow-DOM-specific
handling beyond what `ariaSnapshot` exposes. One page per snapshot. State that
isn't visible on the final page should be checked through probes or the
network log, not by navigating at check time (see "Rejected alternatives").

### 2. Check DSL (`assay.checks/v1`)

```jsonc
{
  "schema": "assay.checks/v1",
  "id": "tiny-shop/place-express-order",
  "version": "1",
  "task": {
    "instruction": "Order one Blue Mug with express shipping.",
    "outcomes": "Then an order is placed\nThen the shipping method is express",
  },
  "requirements": [
    {
      "id": "R1",
      "kind": "hard",
      "text": "An order is placed",
      "source": { "field": "outcomes", "quote": "an order is placed" },
    },
  ],
  "checks": [
    {
      "id": "C1",
      "requirement": "R1",
      "description": "The browser sent POST /api/orders and got 201 with status 'placed'.",
      "assert": {
        "kind": "request",
        "match": {
          "method": "POST",
          "url": { "path": "/api/orders" },
          "status": 201,
          "responseBody": {
            "type": "object",
            "required": ["status"],
            "properties": { "status": { "const": "placed" } },
          },
        },
      },
    },
  ],
}
```

**Traceability.** Every requirement has a `source.quote` that must appear in
`task.instruction` or `task.outcomes` (after case-folding and whitespace
normalization). The validator rejects requirements it can't trace. Every
check names exactly one requirement. A requirement is `hard` (it decides the
overall verdict) or `soft` (reported only).

#### 2.1 Anchors vs. assertions

This is the core rule behind abstain:

> An **anchor** is evidence that should exist whether the agent succeeded or
> not, such as the cart table, the newsletter checkbox or the network log. An
> **assertion** is the part that depends on the outcome, such as whether the
> row is in the table or whether the box is checked.
>
> If an anchor is missing or ambiguous, the check **abstains**. If the anchor
> resolves and the assertion is false, the check **fails**.

Take "cart contains Blue Mug". It is written as _scope_ = table "Cart"
(anchor) and _match_ = row whose name contains "Blue Mug" (assertion). If
the agent added a Red Mug instead, the table exists and the row doesn't, so
the check fails. If a redesign renames the table, the anchor is gone and the
check abstains. It does not wrongly fail, and the case escalates.

#### 2.2 Locators and redundant anchors

```ts
interface Locator {
  role: string; // required: ARIA role
  name?: TextMatch; // accessible name
  text?: TextMatch; // derived descendant text
  level?: number;
  landmark?: { role: LandmarkRole; name?: TextMatch }; // some landmark ancestor
  within?: Locator; // some ancestor matches this locator
}
type Target = Locator | { anchors: Locator[] }; // redundant anchors
```

There is no `nth`, no CSS and no XPath. If a locator matches several nodes,
the anchor is ambiguous and the check abstains. Picking the first match
would be a silent guess.

**Resolving a target with redundant anchors.** Each locator is resolved
independently, then:

1. If no locator matches any node, abstain with `anchor_missing`.
2. If no locator matches exactly one node, abstain with `anchor_ambiguous`.
3. If two locators each match exactly one node and the nodes differ, abstain
   with `anchor_conflict`.
4. Otherwise the target is the node that the unique locators agree on. Each
   remaining locator must either include that node among its matches or
   match nothing. If one excludes it while matching other nodes, abstain with
   `anchor_conflict`.
5. Locators that matched nothing are reported as **drifted**. The check still
   decides. Drift is the early-warning signal for the stability run in
   milestone 5: the UI changed, but not enough to break the check.

#### 2.3 Text matching

```ts
type TextMatch =
  | string // shorthand for { equals }
  | { equals: string; ignoreCase?: boolean }
  | { contains: string; ignoreCase?: boolean }
  | { regex: string; flags?: string };
```

Both sides are canonicalized first: Unicode NFC, all whitespace runs
collapsed to one space, then trimmed. This is part of the snapshot model
(accessible names are already whitespace-normalized) rather than a hidden
normalizer. Anything beyond it, such as case folding, must be asked for
explicitly.

#### 2.4 Assertion kinds

| kind             | anchor(s)                                                             | assertion                                                                                      |
| ---------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `state`          | `target`                                                              | `expect` on states, `name`, `value`, `text`, `level`                                           |
| `contains`       | `scope` (optional; default document) and optional `witness` inside it | number of `match` nodes inside scope satisfies `count` (default `{gte:1}`); `{eq:0}` = absence |
| `value`          | the `source` (see below)                                              | normalized value satisfies `expect`                                                            |
| `url`            | none (the page always has a URL)                                      | `page.url` matches `match`                                                                     |
| `request`        | network channel captured                                              | number of matching entries satisfies `count` (default `{gte:1}`)                               |
| `allOf`, `anyOf` | sub-assertions                                                        | Kleene three-valued logic                                                                      |

A `witness` is a locator for a node that must exist inside the scope
whatever the outcome, such as the cart table's "Product" column header. If
it is missing, the check abstains. Without it, a scope that still resolves
but whose content lost its structure (rows flattened to text) makes a
presence check fail, and worse, an absence check (`count: {eq: 0}`) pass
vacuously. The validator warns about absence checks without a witness.

`contains` without a scope never abstains, because the document always
exists, but an unrelated UI change can then make it fail. Authors and the
compiler should scope it to a landmark or container.

**Value sources** (all evidence is observed; agent claims are never a source):

```ts
type ValueSource =
  | { from: 'node'; target: Target; field: 'name' | 'value' | 'text' | 'url' }
  | { from: 'text'; scope?: Target; pattern: string; flags?: string; group?: number | string }
  | { from: 'url'; part: 'href' | 'origin' | 'pathname' | 'search' | 'hash' | { param: string } }
  | { from: 'request' | 'response'; match: RequestMatch; pointer?: string; pick?: 'only' | 'first' | 'last' }
  | { from: 'storage'; area: 'cookie' | 'local' | 'session'; key: string; origin?: string }
  | { from: 'probe'; probe: string; pointer?: string };
```

`pointer` is an RFC 6901 JSON Pointer into a JSON body or probe value.
`pick` defaults to `only`: if several requests match, the value is
ambiguous and the check abstains. `last` is for "the final state was saved".

A `value` check reads, then normalizes, then compares. **Abstain means the
value couldn't be determined.** That covers a missing anchor, no matching
request, a missing pointer path, a regex that doesn't match, a redacted
value, or a normalizer that can't parse the input. **Fail means the value
was determined and is wrong.** There is one deliberate exception: a storage
key or cookie that isn't set, while the storage channel was captured, is an
_observed absence_. Storage is a flat key-value map, so absence there is
determinate. The check fails unless it expects `null`. A missing path inside
a probe or response body still abstains, because that usually means the
API's shape changed. To assert that something must exist (for
example that the order request happened), pair the `value` check with a
`request` or `contains` check, which fail when the thing is absent.

**Request matching:**

```ts
interface RequestMatch {
  method?: string | string[];
  url?: UrlMatch;
  status?: number | NumberCompare;
  requestBody?: JSONSchema; // JSON Schema (draft 2020-12 subset via Ajv)
  responseBody?: JSONSchema;
}
interface UrlMatch {
  path?: string; // "/orders/:id", "*" matches one segment, "**" any suffix
  regex?: string; // against the full href
  origin?: string;
  query?: Record<string, TextMatch | null>; // null = parameter must be absent
}
```

Matching uses JSON Schema, not equality. "The response has status
`placed`" stays true when the server adds fields, which keeps a check from
over-constraining.

#### 2.5 Normalizers

`normalize` is an ordered pipeline of pure, typed steps. Each step takes the
output of the previous one. Locale and timezone are **required** wherever
parsing depends on them. Checks never read host settings.

| op                                                                                | in → out                            | notes                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trim`, `collapseWhitespace`, `lowercase`, `uppercase`, `nfkc`, `stripDiacritics` | string → string                     |                                                                                                                                                                                                                                                                 |
| `extract {regex, flags?, group?}`                                                 | string → string                     | no match ⇒ `normalize_failed`                                                                                                                                                                                                                                   |
| `replace {regex, with}`                                                           | string → string                     |                                                                                                                                                                                                                                                                 |
| `number {locale}`                                                                 | string → number                     | Separators come from `Intl` for that locale. The whole string must be a number: no stray text. Accepts `-`, `−`, `+` and accounting `(…)`                                                                                                                       |
| `currency {locale, currency?}`                                                    | string → money `{amount, currency}` | Symbol or ISO code before or after the amount. An ambiguous symbol (`$`, `¥`, `kr`) resolves through `currency`. A symbol that contradicts it gives the symbol's currency, so the comparison fails. An ambiguous symbol without `currency` ⇒ `normalize_failed` |
| `date {locale, timezone?}`                                                        | string → `"YYYY-MM-DD"`             | ISO dates, numeric dates in the locale's field order, and English or locale month names. Two-digit years, relative dates ("tomorrow") and invalid days ⇒ `normalize_failed`. An ISO datetime with an offset is converted to `timezone` (required in that case)  |
| `json`                                                                            | string → Json                       | parse failure ⇒ `normalize_failed`                                                                                                                                                                                                                              |
| `boolean`                                                                         | string → boolean                    | true/false/yes/no/on/off/1/0                                                                                                                                                                                                                                    |

A parse failure **abstains** rather than fails. Seeing "N/A", "—" or a new
date format means the check's model of the page is wrong. It does not show
that the agent failed, and an LLM judge or human should look at it.

#### 2.6 Comparisons (`expect` of a `value` check)

Each comparison object has exactly one operator:

| operator                     | applies to          | semantics                                                     |
| ---------------------------- | ------------------- | ------------------------------------------------------------- |
| `equals`                     | any                 | deep equality; strings are canonicalized as in 2.3            |
| `oneOf`                      | any                 | equals one of the listed values                               |
| `contains`, `regex`          | string              | on canonical text                                             |
| `approx {value, abs?, rel?}` | number, money, date | `                                                             | a-b | <= max(abs, rel· | b   | )`. For money the currency must also be equal. For dates `abs` is in days |
| `gt` / `gte` / `lt` / `lte`  | number, money, date | ranges can combine bounds in one object                       |
| `schema`                     | Json                | validates against a JSON Schema                               |
| `exists`                     | any                 | the value was read and normalized and is not the empty string |

If the value's type doesn't match the operator (for example `approx` on an
un-normalized string), the check abstains with `type_mismatch`. The
validator flags the obvious cases before the check runs.

#### 2.7 Results and aggregation

```ts
interface CheckResult {
  check: string;
  requirement: string;
  status: 'pass' | 'fail' | 'abstain';
  reason?: AbstainReason; // set iff abstain
  message: string; // plain-language explanation
  evidence: Evidence[]; // what decided it
  drift: string[]; // anchors that matched nothing
}
interface Evidence {
  channel: 'a11y' | 'text' | 'url' | 'network' | 'storage' | 'probe';
  trust: 'structured' | 'semantic' | 'freetext';
  origin: 'observed'; // runtime evidence is always observed
  locator?: string; // e.g. main › table "Cart" › row "Blue Mug …"
  value?: Json;
}
type AbstainReason =
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
```

Aggregation uses strong Kleene logic everywhere:

- `allOf` (and a requirement over its checks): fails if any part fails,
  passes if all pass, otherwise abstains.
- `anyOf` passes if any part passes, fails if all fail, otherwise abstains.
  This is how alternative permitted paths are written.
- A requirement with no checks abstains with `uncovered`.
- The **overall verdict** is the `allOf` of the hard requirements, giving
  `success`, `fail` or `abstain`. Soft requirements are reported but don't
  affect it.

The `origin` field exists so that once trajectories are attached
(milestone 4), the report can show the agent's claims next to the evidence,
labeled `agent-claimed`. The runtime never treats a claim as evidence.

### 3. Runtime

- `evaluate(checkSet, snapshot) → Outcome` is a pure function. It is the
  only evaluator.
- **Live mode is capture, then evaluate.** `verifyPage(page, checkSet)` takes
  a snapshot of the live page and evaluates it. This makes live and offline
  results identical by construction. `expectOutcome` in Playwright polls
  (capture and evaluate every ~250 ms until success or timeout), like
  Playwright's web-first assertions, to absorb UI settling.
- A check set is validated (JSON Schema plus semantic checks: unique IDs,
  requirement references, traceable quotes, compilable regexes, normalizer
  and comparison type compatibility) before it runs. An invalid set is an
  error and never produces a verdict.

## Consequences

**Positive**

- Stress testing reduces to JSON transforms on snapshots, with no browser
  involved (milestone 3).
- The abstain boundary is explainable: abstain means the check couldn't find
  or read its evidence, and fail means it read the evidence and the outcome
  is wrong. A reviewer can check this per check.
- Drift reporting shows UI changes before they break a check.
- Checks are portable, diffable and lockable. Their digests can go into
  audit records.

**Negative / accepted risks**

- `ariaSnapshot` fidelity limits: false states can't be told apart from
  missing ones, there are no iframes, and accessible names depend on how
  well the app marks up its UI. Apps with poor accessibility will push
  checks toward the `text` channel, which is spoofable. The compiler must
  report that as low-trust coverage.
- A snapshot covers one page. A requirement observable only on another page
  needs a probe or network evidence. Some tasks will need users to write
  probes.
- An unscoped `contains` and a `value` check without a paired existence
  check can each fail or abstain in ways an author might not expect.
  Mitigation: validator lints, plus checks on these patterns in the stress
  test.
- The body tap wraps `window.fetch` and `XMLHttpRequest` in the page under
  test. It is transparent (no rerouting, no extra requests, streaming
  `text/event-stream` responses are skipped), but it is still an
  instrumentation of the system under test.
- Recording the network from context start means users must use the Assay
  fixture or the recorder. A snapshot taken without it abstains on network
  checks, which is safe but surprising.

## Rejected alternatives

- **Checks as code (JS predicates or Playwright scripts).** These are the
  most expressive, but they are unreviewable, unlockable, impossible to
  mutation-test structurally, and they repeat VerifierBench's failure mode
  of arbitrary over-specific conditions.
- **CSS/XPath selectors.** They are brittle under redesigns and blind to
  semantics. They also encourage anchoring on implementation details the
  task never mentions.
- **First match on ambiguity.** It turns uncertainty into a silent guess.
- **Two outcomes (fail on missing anchor).** This makes UI drift look like
  agent failure, which destroys the true positive rate, the metric
  VerifierBench showed is weakest.
- **Check-time navigation to other pages ("views").** It is useful but
  causes side effects and breaks the rule that a snapshot is the complete
  evidence. It is deferred and may come back as a captured multi-page
  evidence bundle.
- **Capturing bodies by routing every request through Playwright
  (`route.fetch()` + `fulfill`).** It is reliable, but it changes how the
  app's requests are made (cookie handling, HTTP/2, streaming, caching).
  A verifier must not alter the system it verifies.
- **Raw HTML/DOM in snapshots.** Large, noisy and full of implementation
  detail. The `text` channel covers what visible text offers, and a11y
  covers structure.

## Revisions made while building milestone 1

Implementation and the Tiny Shop acceptance tests changed the first draft
in three places:

1. **`witness` on `contains`.** In the first draft, a table whose rows lost
   their roles (flattened to text) still resolved as an anchor. Presence
   checks then failed, and absence checks would have passed vacuously.
   Absence is the dangerous direction, because it produces a false
   success.
2. **Storage absence is observed absence.** An unset cookie made "switch to
   German" abstain, but the agent simply hadn't done it. With the storage
   channel captured, a missing key is outcome evidence.
3. **Response-body tap and three-valued request matching.** POST bodies
   were lost on navigation (see §1). The first draft also treated an
   unreadable body as a non-match, which would have failed correct runs.

## Open questions (later milestones)

- Bindings between checks, for example "the order ID on the page equals the
  ID in the POST response", via named captures.
- An escalation policy per check (`onAbstain`, `onFail: "escalate"`) and
  locking metadata (`locked: {by, at, digest}`), in milestone 4/5.
- Datetime comparisons with tolerance in minutes.
