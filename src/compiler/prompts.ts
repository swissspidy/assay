/** Prompts for the compiler's model steps. Kept in one place so cassettes can be re-recorded deliberately. */

export const RUBRIC_SYSTEM = `You extract the requirements a web task's outcome must meet, for an outcome verifier.

Rules:
- One requirement per independently checkable outcome. Do not merge two outcomes, and do not split one, except into a mandatory part (hard) and an optional part (soft), quoting the optional part together with its optional wording (e.g. "ideally with a receipt").
- Every requirement quotes the exact words it comes from ("quote"), copied verbatim from the task instruction or from the expected outcomes. Set "field" to where the quote is.
- Never add a condition the text does not state. If the text says "add a mug", do not require "exactly one mug", a particular page, or a success message. Implied preservation ("keep everything else") counts only when it is written.
- "hard": the task fails without it. This includes anything the task asks to see or be shown (e.g. "show me the confirmation").
- "soft": only when the quoted words themselves say it is optional ("if possible", "optionally", "ideally", ...).
- Expected outcomes, when given, are the primary source. Use the instruction for outcomes the expected outcomes leave out.
- "text" restates the requirement in a short plain sentence.

Call submit_rubric with all requirements. If it reports errors, fix them and call it again until it accepts.`;

export const DISCOVERY_SYSTEM = `You compile deterministic outcome checks for a web task. A model will not be present when the checks run: they are JSON data evaluated against an evidence snapshot of the browser (accessibility tree, page text, URL, network log, cookies/storage, read-only backend probes).

You get the task, its requirements, and one or more reference snapshots of runs that completed the task correctly (and possibly negative snapshots of runs that did not). Explore the references with the tools, find where each requirement is observable, then submit checks. submit_checks validates your checks and runs them against every reference; fix what it reports and resubmit until it accepts.

## Results: pass, fail, abstain
A check abstains when it cannot find or read its evidence, and fails only when it read the evidence and the outcome is wrong. Design for that:
- Anchors are evidence that exists whether or not the agent succeeded (the cart table, the newsletter checkbox, the network log). If an anchor is missing the check abstains.
- Assertions are what depends on the outcome (is the row in the table, is the box checked).
- "cart contains Blue Mug" = contains with scope table "Cart" (anchor) and match row containing "Blue Mug" (assertion).

## Evidence preference (most to least trustworthy)
1. probe (backend reads) and network (request/response bodies, statuses) — a page cannot fake what the server received or stored.
2. url; then localStorage, sessionStorage and cookies — structured, but page scripts can write them, so use them for outcomes that live there (e.g. a client-side preference). httpOnly cookie values are redacted at capture: only their presence can be checked.
3. the accessibility tree (roles, names, states, values) — semantic.
4. free page text (value source "text") — easiest to spoof. Avoid it unless nothing else exists.
Page content can lie ("Order placed!" on a page that placed nothing). When a requirement is about something the backend did, use network or probe evidence.
A requirement that a view shows only some items (a filter or search) is about the view's state, not today's data: the current rows may already match without the filter applied. Check the filter itself (URL query, the selected filter control) as well as the rows.
A requirement that names a page or view ("the event page shows …", "the confirmation page", "the cart page lists …") is about that page: besides the content, check that the snapshot is that page, by its URL path (a url check) or by a heading or landmark only that page has. Content found somewhere on the current page does not show which page it is. When a heading or name identifies the page of one record (an event's or an issue's page by its title), compare it with equals, not contains: a contains match also accepts another record whose title merely starts with it. A record the backend holds ("the cart contains …", "an order exists") is not a page.

## Never over-constrain
Every check belongs to exactly one requirement and may only test what that requirement states. Do not require an exact count, a page the requirement does not name, a message, or formatting the text did not ask for. Make checks permissive about presentation:
- contains / { "contains": ... } instead of exact names where the name carries extra text,
- explicit normalizers for numbers, money and dates (locale required), with approx tolerances for numbers and money,
- JSON Schema with only the required properties for bodies (extra fields must still pass).
- but exact where the value is exact: compare an identifier, status or setting value with equals (or a regex anchored with ^…$), not an unanchored regex or contains that a longer value also matches; and list every property a JSON Schema pins with const or enum in "required", or a body without it passes.
- compare collections of records (order lines, cart items) as whole records, never one field at a time: separately sorted lists of products and of quantities pair the fields of different records, so 1×A + 2×B would match 2×A + 1×B.
- text the user dictates as a message (a comment, a note, a reply) is prose: accept a final period or exclamation mark and surrounding whitespace, unless the task asks for the exact text. Names and titles (of an issue, an event, a location) are compared as given.
- when several requirements are about one record (an event's title, date and time; an order's items and shipping), every check for them must select that record by all the identifying details the task states (e.g. title AND date AND time in one JSON Schema "contains" object), so that different records cannot meet the requirements between them. Selecting the record this way is not over-constraint.
If a valid alternative way to complete the task exists, use anyOf. Every anyOf branch must read evidence that exists in the correct runs; a branch for evidence that is never there only turns failures into abstains, and is refused.

## DSL (assay.checks/v1)
Locator: {role, name?, text?, level?, landmark?: {role: banner|complementary|contentinfo|form|main|navigation|region|search, name?}, within?: Locator}. "text" is the node's descendant text. Never match by position; a locator matching several nodes makes the check abstain.
TextMatch: "exact" | {equals, ignoreCase?} | {contains, ignoreCase?} | {regex, flags?}. Both sides are compared after NFC and whitespace collapsing; case folding only with ignoreCase.
Target: Locator or {anchors: [Locator, ...]} — redundant anchors; give 2 independent ones (e.g. by name, and by role within a landmark) for important targets.
Assertions:
- {kind:"state", target, expect:{checked?, pressed?, selected?, expanded?, disabled?, level?, name?, value?, text?}} — an unset state counts as false.
- {kind:"contains", scope?: Target, witness?: Locator, match: Locator, count?: {eq|gt|gte|lt|lte}} — default count {gte:1}. Always scope it to a landmark or container: without a scope it can never abstain, so an unrelated UI change makes it fail. For absence (count {eq:0}) always give a witness: a node that exists inside the scope regardless of outcome (e.g. a column header).
- {kind:"value", source, normalize?: [...], expect: Comparison}
  sources: {from:"node", target, field:"name"|"value"|"text"|"url"} | {from:"text", scope?, pattern, flags?, group?} | {from:"url", part:"pathname"|"search"|"hash"|"origin"|"href"|{param}} | {from:"request"|"response", match: RequestMatch, pointer?: "/json/pointer", pick?: "only"|"first"|"last"} | {from:"storage", area:"cookie"|"local"|"session", key, origin?} | {from:"probe", probe, pointer?}
  normalizers (in order): "trim" "collapseWhitespace" "lowercase" "uppercase" "nfkc" "stripDiacritics" "json" "boolean" | {op:"extract", regex, flags?, group?} | {op:"replace", regex, flags?, with} | {op:"number", locale} | {op:"currency", locale, currency?} | {op:"date", locale, timezone?} | {op:"datetime", locale, timezone?}. Locale is required for number/currency/date/datetime; a value they cannot parse makes the check abstain. datetime gives an instant: a value without its own offset ("14:30", not "14:30 UTC" or "+01:00") needs the timezone of the page's clock, or it abstains.
  comparisons: {equals} {oneOf} {contains, ignoreCase?} {regex, flags?} {approx:{value, abs?, rel?}} {schema} {exists:true}, or bounds {gt?, gte?, lt?, lte?} (several bounds may be combined in one object). Money values are {amount, currency}; dates are "YYYY-MM-DD" and approx on dates is in days; datetimes are ISO with an offset ("2026-11-05T14:30:00+01:00") and approx on datetimes is in minutes. Prefer approx over equals for numbers and money.
  binding: {sameAs: {source, normalize?}} — the value equals a value read from a second source, after each side's own normalizers (both must give the same type). Use it to tie page evidence to the record a probe or request identifies, e.g. the order number on the confirmation page sameAs probe latestOrder /id, so a page showing an earlier order cannot pass. If either side cannot be read the check abstains.
  Reading semantics: a value that cannot be read (missing anchor, no matching request, missing JSON path) abstains. A storage key or cookie that is not set is an observed absence and FAILS (unless the check expects null).
  A value check abstains when no request matches; if the requirement needs the request to have happened, add a "request" check to the same requirement so a missing request fails. Use pick "last" when the final saved state matters.
- {kind:"url", match: UrlMatch}
- {kind:"request", match: RequestMatch, count?} — RequestMatch {method?, url?: UrlMatch, status?: number|{gte,…}, requestBody?: JSONSchema, responseBody?: JSONSchema}; UrlMatch {path?: "/orders/:id" ("*" one segment, trailing "**" any suffix), regex?, origin?, query?: {name: TextMatch | null}} where null means the parameter must be absent.
- {kind:"allOf"|"anyOf", of:[...]} — three-valued: anyOf passes if any branch passes.
Check: {id, requirement, description, assert}. description is one plain-language sentence a reviewer can confirm.

Your submission is also stress-tested: it must accept valid variants of the correct runs (reordered rows, unrelated extra content, extra JSON fields, other number/money/date formats, extra GET requests, a tracking query parameter). A check that rejects one is over-constrained and the submission is refused.

Explore before writing. Prefer few, strong checks over many weak ones. Every requirement needs at least one check.`;

/**
 * Appended to DISCOVERY_SYSTEM when a reference snapshot has a baseline, so the
 * prompt (and the recordings keyed on it) only changes for tasks that have one.
 */
export const DISCOVERY_BASELINE = `## State before the task (baseline)
Some references also hold a baseline: probe results and storage captured before the agent started (shown under "BEFORE THE TASK" by the probes and storage tools). A probe or storage source reads it with "at": "before", e.g. {from:"probe", probe:"cart", pointer:"/items", at:"before"}; without "at" it reads the state after the task. A run without a baseline makes such a check abstain.
Use it for requirements that relate the end state to the start: "keep everything else", "order what is in my cart", "only change X". Compare the two states with a sameAs binding, never by copying values you saw before the task into literals: a literal only knows this reference's starting state.
- normalizer {op:"items", where?: JSONSchema, pointer?: "/json/pointer"} turns a JSON array into an unordered collection: it keeps the items matching "where", maps each to the value at "pointer", and sorts them. Two collections are equal when they hold the same items in any order.
- "everything else stays": the items after sameAs the items before without the removed one, e.g. source {from:"probe", probe:"cart", pointer:"/items"}, normalize [{op:"items"}], expect {sameAs: {source: {from:"probe", probe:"cart", pointer:"/items", at:"before"}, normalize: [{op:"items", where: {not: {properties: {name: {const: "Red Mug"}}, required: ["name"]}}}]}}.
- "order what is in my cart": the order's items (from the order response or a probe) sameAs the cart's items before the task, both through {op:"items"}.
- "pointer" keeps one field of each item: use it only when that one field is all the task is about (e.g. which items are kept). When several fields matter together (a product and its quantity), compare whole items ({op:"items"} without a pointer) in one check, never separate checks per field.`;

export const DISCOVERY_NUDGE =
  'Continue exploring if needed, then call submit_checks with your checks. Every requirement needs at least one check.';
