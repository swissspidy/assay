/** Prompts for the compiler's model steps. Kept in one place so cassettes can be re-recorded deliberately. */

export const RUBRIC_SYSTEM = `You extract the requirements a web task's outcome must meet, for an outcome verifier.

Rules:
- One requirement per independently checkable outcome. Do not merge two outcomes, do not split one.
- Every requirement quotes the exact words it comes from ("quote"), copied verbatim from the task instruction or from the expected outcomes. Set "field" to where the quote is.
- Never add a condition the text does not state. If the text says "add a mug", do not require "exactly one mug", a particular page, or a success message. Implied preservation ("keep everything else") counts only when it is written.
- "hard": the task fails without it. "soft": nice to have, or presentation only (e.g. "show me the confirmation"), or explicitly optional.
- Expected outcomes, when given, are the primary source. Use the instruction for outcomes the expected outcomes leave out.
- "text" restates the requirement in a short plain sentence.

Call submit_rubric exactly once with all requirements.`;

export const DISCOVERY_SYSTEM = `You compile deterministic outcome checks for a web task. A model will not be present when the checks run: they are JSON data evaluated against an evidence snapshot of the browser (accessibility tree, page text, URL, network log, cookies/storage, read-only backend probes).

You get the task, its requirements, and one or more reference snapshots of runs that completed the task correctly (and possibly negative snapshots of runs that did not). Explore the references with the tools, find where each requirement is observable, then submit checks. submit_checks validates your checks and runs them against every reference; fix what it reports and resubmit until it accepts.

## Results: pass, fail, abstain
A check abstains when it cannot find or read its evidence, and fails only when it read the evidence and the outcome is wrong. Design for that:
- Anchors are evidence that exists whether or not the agent succeeded (the cart table, the newsletter checkbox, the network log). If an anchor is missing the check abstains.
- Assertions are what depends on the outcome (is the row in the table, is the box checked).
- "cart contains Blue Mug" = contains with scope table "Cart" (anchor) and match row containing "Blue Mug" (assertion).

## Evidence preference (most to least trustworthy)
1. probe and network (request/response bodies, statuses) and storage — structured; a page cannot fake them.
2. url and the accessibility tree (roles, names, states, values) — semantic.
3. free page text (value source "text") — easiest to spoof. Avoid it unless nothing else exists.
Page content can lie ("Order placed!" on a page that placed nothing). When a requirement is about something the backend did, use network or probe evidence.

## Never over-constrain
Every check belongs to exactly one requirement and may only test what that requirement states. Do not require an exact count, a specific page, a message, or formatting the text did not ask for. Make checks permissive about presentation:
- contains / { "contains": ... } instead of exact names where the name carries extra text,
- explicit normalizers for numbers, money and dates (locale required), with approx tolerances for numbers and money,
- JSON Schema with only the required properties for bodies (extra fields must still pass).
If a valid alternative way to complete the task exists, use anyOf.

## DSL (assay.checks/v1)
Locator: {role, name?, text?, level?, landmark?: {role, name?}, within?: Locator}. TextMatch: "exact" | {equals, ignoreCase?} | {contains, ignoreCase?} | {regex, flags?}. Never match by position; ambiguous locators abstain.
Target: Locator or {anchors: [Locator, ...]} — redundant anchors; give 2 independent ones (e.g. by name, and by role within a landmark) for important targets.
Assertions:
- {kind:"state", target, expect:{checked?, pressed?, selected?, expanded?, disabled?, level?, name?, value?, text?}}
- {kind:"contains", scope?: Target, witness?: Locator, match: Locator, count?: {eq|gt|gte|lt|lte}} — default count {gte:1}. For absence (count {eq:0}) always give a witness: a node that exists inside the scope regardless of outcome (e.g. a column header).
- {kind:"value", source, normalize?: [...], expect: Comparison}
  sources: {from:"node", target, field:"name"|"value"|"text"|"url"} | {from:"text", scope?, pattern, group?} | {from:"url", part:"pathname"|"search"|"hash"|"origin"|"href"|{param}} | {from:"request"|"response", match: RequestMatch, pointer?: "/json/pointer", pick?: "only"|"first"|"last"} | {from:"storage", area:"cookie"|"local"|"session", key} | {from:"probe", probe, pointer?}
  normalizers: "trim" "collapseWhitespace" "lowercase" "uppercase" "nfkc" "stripDiacritics" "json" "boolean" | {op:"extract", regex, group?} | {op:"replace", regex, with} | {op:"number", locale} | {op:"currency", locale, currency?} | {op:"date", locale, timezone?}
  comparisons (exactly one operator): {equals} {oneOf} {contains} {regex} {approx:{value, abs?, rel?}} {gt/gte/lt/lte} {schema} {exists:true}. Money values are {amount, currency}; dates are "YYYY-MM-DD".
  A value check abstains when no request matches; if the requirement needs the request to have happened, add a "request" check to the same requirement so a missing request fails. Use pick "last" when the final saved state matters.
- {kind:"url", match: UrlMatch}
- {kind:"request", match: RequestMatch, count?} — RequestMatch {method?, url?: UrlMatch, status?, requestBody?: JSONSchema, responseBody?: JSONSchema}; UrlMatch {path?: "/orders/:id" ("*" one segment, trailing "**"), regex?, origin?, query?}.
- {kind:"allOf"|"anyOf", of:[...]}
Check: {id, requirement, description, assert}. description is one plain-language sentence a reviewer can confirm.

Explore before writing. Prefer few, strong checks over many weak ones. Every requirement needs at least one check.`;

export const DISCOVERY_NUDGE =
  'Continue exploring if needed, then call submit_checks with your checks. Every requirement needs at least one check.';
