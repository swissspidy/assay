# ADR 0020: Mining-first compiler

- Status: Accepted
- Date: 2026-11-06
- Scope: `compileTask` (`discovery`), `@swissspidy/assay/compiler` (mining API), `assay compile`
  (`--mine-first`, `--mine-only`), config (`compile.discovery`), `compiled.discovery`,
  `scripts/bench.ts` (`mine`), `scripts/mine.ts`
- Builds on: [ADR 0002](0002-compiler.md), [ADR 0011](0011-route-robust-compilation.md),
  [ADR 0015](0015-evidence-store-and-compiled-checks.md), [ADR 0016](0016-overlay-stress-and-capture-digests.md)

## Context

Every compile (ADR 0002) runs a discovery agent. On the 74 committed compiles (30 example tasks,
44 real-app tasks) that is 224 model turns, 4.86 M input and 86 k output tokens, after the rubric.
Much of what the agent finds is mechanical: "the order ships express" becomes "the latest order's
`shipping` is `express`", a value that sits in a probe and whose word is in the quote. ADR 0015
made it cheap to run many checks over many snapshots (`runPlanMany`, overlays), and named this
follow-up: run candidate checks as plans over many stores before asking a model.

The constraints are ADR 0002's. A check must never add a condition the quote does not state, and
the acceptance gate (validation, every correct reference passes, no incorrect one succeeds, no
stress variant fails or abstains) must not weaken. The default compile must stay byte for byte
what it is, so committed check sets, reports and cassettes replay unchanged.

## Decision

`compileTask(task, refs, { discovery })` with three strategies:

- `'model'` (the default): as before. No mining runs, no tool or prompt changes.
- `'mine-first'`: mine; if mining covers every requirement and the whole set passes the gate, no
  discovery turn runs. Otherwise the agent is started on the requirements mining left open.
- `'mine-only'`: mine, never ask for checks. With `rubric: 'deterministic'` (or given
  `requirements`) no model is resolved at all. A requirement mining cannot cover fails the compile
  with one line per open requirement saying why.

The CLI takes `--mine-first` / `--mine-only`, the config `compile: { discovery }` (used by
`compileTask` only when a config is passed, as ADR 0017 requires).

### 1. Candidates (`generateCandidates`)

Per requirement, from the correct references only, in ADR 0001's trust order:

| Family  | Candidate                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| probe   | `equals` on a single named leaf, else a like-shape schema of the value (`type`/`required`/`const`/`contains`)            |
| storage | local/session values (`json`-normalized shapes), cookies                                                                 |
| network | a succeeded `POST`/`PUT`/`PATCH`/`DELETE` by method, origin and path (ids as `*`), with a request or response body shape |
| url     | the page's path with the segments the quote names literal, the rest `*`                                                  |
| a11y    | headings, landmarks, dialogs, status/alert/row/list item/article text, and control states                                |

Quotes with set words get set comparisons too (section 1a).

**What a quote names.** A value is pinned only when the quote states it:

- a string whose words occur in the quote as a run, case, punctuation, spacing and inflection aside
  (`sameWord`: equal, a plural `s`, or a shared stem of four or more letters: close/closed,
  shipping/ships, confirmation/confirmed);
- a number the quote writes as digits or a number word (`two`), outside dates, times and `#n`; a
  field that identifies a record (`id`, `number`, `…Id`) only as `#n`;
- an ISO date or date-time whose date (and time) the quote spells (`November 5, 2026 at 12:30`);
- a boolean only under a field whose name is a quoted word (`newsletter: true` for "the newsletter
  subscription"), `false` when the condition that names it negates. Negation belongs to its
  condition (the quote split at commas, semicolons, "and", "but", "while"): "notifications are not
  enabled and the newsletter is enabled" pins `notificationsEnabled: false` and
  `newsletterEnabled: true`. The conditions naming most of the field's words decide; when they
  disagree, nothing is pinned;
- a control state only for a state word in a condition that names the control (`checked`,
  `selected`, `pressed`, …). A switch is on or off only when the word is its state ("is on",
  "turned off", "not off"), not a place ("visible on the Settings page").

Prose fields (`text`, `body`, `comment`, …) of two or more words match as an anchored pattern
allowing closing punctuation (`^\s*Working on it[.!]?\s*$`): a trailing period is not a different
comment. Where evidence is read (probe, pointer, request method and path, role) is not a condition.

**Whole records.** A list of records yields one record shape with every named field of the record
that has the most (records the task added or changed, by the baseline, first). A record without a
field that names it (`id`, `title`, `name`, a prose field) matches any such record (`{labels
contains "bug"}`), so it never settles a requirement.

**At most twelve per family.** Each requirement keeps at most twelve candidates per family. When a
family has more, the ones leaving fewest quote words unaccounted for (section 3) are kept, then
the ones that state a value, then the first found: twelve probes that merely hold "express" do not
crowd out a later `orderShips` probe that accounts for "the order ships express". Among those
leaving as few words, a set comparison the quote asks for (section 1a) comes first.

### 1a. Set comparisons: "add", "only", "every"

A quote has one **form**, from its set words outside quotation marks: `plain` (none), `add` ("add",
"put", "append", "insert"), `only`, or `every` ("every", "all", "each"). A quote that mixes them,
negates ("not", "no", "un…", "remove"), or speaks of the rest of a collection or an absence ("other",
"else", "keep", "no longer", "except") has none, and mining settles nothing for it. Only a candidate
that expresses the quote's form can settle it: the plain "the cart contains a Blue Mug" survives for
"add a Blue Mug to the cart" but never settles it.

- **"Add X"** (ADR 0011: adding keeps what is there), for a probe or storage collection whose
  baseline value is a list in every correct reference: an `allOf` of the plain `contains` X and
  `{normalize: [items where not X], expect: {sameAs: {source: {…, at: "before"}, normalize: [the
  same]}}}`. Which collection X joined comes from the baseline: a record the baseline lacks (by its
  identifying fields) joined the collection read (a new user, a wishlist entry; `where` is the whole
  record shape, so a changed old record is not hidden); a record the baseline already held gained X
  in its one list field (a post's tags), read with `items` `flatten` on the record and compared
  without X. X must be one identified record or one listed value. It settles only with a baseline
  (`baseline` not null), and on its own only when the baseline fails it (X was not already there).
  An "add" whose correct reference dropped what was there does not survive.
- **"Only X"** over a probe's or storage key's records: `{type: array, minItems: 1, items: X}`, with
  X the record shape the plain candidate builds (every named field, each bound as before). Every
  named value must stand after "only".
- **"Every X is Y"**: the record's named fields are split by where the quote names their values
  (`Quote.placeOf`): in the noun phrase "every" opens (up to a copula, relative pronoun or
  preposition: "every _open bug_ in …") is X, after it is Y; a value ahead of the set word, or a
  non-string value, gives no candidate. `{items: {anyOf: [{not: X}, Y]}, contains: {allOf: [X,
  Y]}}`, the `contains` being the witness; with no X field, every record is Y and there is one.
- **In a table** (ADR 0008 per-record checks): an `each` whose records are the non-blank cells of
  one column (so the header row is no record, and the stress test's blank extra row is none either),
  each reading exactly the value the quote names, the column header as witness and `count: {gte:
  1}`; several qualifying columns also give one `allOf` ("only the open bugs"). For "every", the
  value must be in the predicate. A table is a view: that it lists only open issues may be the data
  (no closed issue matches its other filter), not the filter the quote asks for. Tiny Tracker 10's
  `only-bugs` run (label filter only, one bug, open) shows the correct run's page exactly. So a table
  check is not `stated`: it settles only when it rejects an incorrect reference.

A set comparison accounts for the quote with its plain core (the same values, each field once): its
`not`, witness and before side repeat values and do not count twice for bindings.

### 1b. Field-name synonyms

`FIELD_SYNONYMS` is a tiny, curated table of words the committed quotes use for fields the apps
spell otherwise: quantity → `qty`, preference → `settings`/`prefs`, appointment → `event`,
category → `categories` (the `y`/`ies` plural `sameWord` does not reduce), labelled/labeled →
`label`, repository → `repo`. A quote word is accounted for by a **field name** (a probe name,
storage key, pointer segment, schema property, table column) spelled as one of its synonyms, and a
binding ("the quantity is 2") is held by a value under such a field (`qty: 2`). Never by a value: a
compared value, a node's name, a URL or request path never accounts for a word through the table,
and `namesString`/`namedScalar` (which values the quote names, booleans included) do not read it.

### 2. Batch evaluation (`mineCandidates`)

All candidates of all requirements form one check set and one plan. Stores are built once:

- `runPlanMany` over every reference (correct and incorrect);
- for each correct reference, its stress variants (`generateVariants` of the pool, `skipVariants`
  applied) as overlays on the reference's `PlanRun` (ADR 0016), running only the candidates still
  alive and only where the variant changed what they read;
- `runPlanMany` over the baseline view (the snapshot with the baseline's probes, storage and URL),
  for probe, storage and URL candidates.

A candidate **survives** when it passes on every correct reference and every variant. It is ranked
by discrimination (incorrect references it rejects, plus one when the baseline fails it), then by
family (probe, storage, network, URL, tree), then by size.

### 3. What settles a requirement

A survivor is **decisive** only when all of these hold:

1. **It accounts for the quote.** Every content word of the quote (filler, generic outcome verbs
   such as "is saved" or "exists", and quantifiers removed) is among the candidate's evidence words
   (the probe and field names, path segments, roles, the compared values and state words), and
   every number, `#n`, date and time the quote states is among its compared values, once for each
   time the quote states it ("the quantity is 2 and the price is 2" needs two compared values, not
   one scalar). **Values are bound to their fields.** A condition that states a number, date or
   time for a field ("the price is 2", "the cart total is $21.50", "2 guests", and the coordinated
   "the quantity and price are 2") needs a compared value of its own that equals the stated one
   and whose key path names the field: the leaf's own key and the keys above it inside the compared
   value (a pointer's segments, a schema's property names). The probe, storage key or request it
   is read from never stands in for the field; those names account only for context words. So
   `quantityPrice: {quantity: 2, discount: 2}` does not settle "the quantity is 2 and the price is
   2", `cartTotal: 21.5` does not settle "the cart total is $21.50" (`cart.total` does), and a value
   next to a name rather than a field ("one Red Mug") stays open. A value with no field next to it
   ("on November 7, 2026", "at 08:00") binds nothing and only has to be compared. Every occurrence
   binds on its own: "2 adults, 2 children" needs an `adults` and a `children` value of 2 (a list's
   commas part it, a date's "May 5, 2026" comma does not). Other fields the
   quote coordinates ("X, Y and Z") likewise each need a compared value of their own, named by its
   key path or value: one scalar never settles them. Words about which page is open
   ("page", "screen") are accounted for only by tree or URL evidence. Words about what it presents
   ("shows", "visible") and kinds of element ("button", "checkboxes", "heading"; the noun, singular
   or plural, not a verb that shares its stem such as "linked" or "switched") are accounted for
   only by tree evidence (its role, name and state), never by a URL, request path or field name that
   spells them: `/checkout-button-visible` does not settle "the Checkout button is visible". Inside
   quotation marks they are part of a name or value ("Yes, see the docs.") and are accounted for
   like any other word. A word the quote uses twice must be accounted for twice ("the Dentist event is called "Dentist (Dr. Lee)"").
2. **It expresses the quote's form** (section 1a). A plain quote needs a plain candidate; "add",
   "only" and "every" need their set comparison; a quote with no form ("other", "no longer",
   "keep", a negated or mixed set) is never settled by mining. Words inside quotation marks are
   names, not set words.
3. **It is evidence of the outcome.** It rejects an incorrect reference, or it compares a value the
   quote names (a stated candidate, with its records identified) and the baseline did not already
   pass it. A request, a URL or a node that is merely present settles nothing without an incorrect
   reference that lacks it. A request body is what the browser asked for, not what the server did:
   a POST answered with a redirect to the login page, a 200 login page or a 200 validation error
   (`{"id": null, "error": "validation failed"}`) sends the same body. So a request-body candidate
   never settles a requirement by itself, whatever the answer; only an incorrect reference that
   fails it makes it decisive. The network evidence that settles a requirement on its own is a
   response body that echoes the values the quote states: each pinned as `const` (so never null)
   and bound to its field as above. Every request candidate names the origin the references sent it
   to, so the same path and body sent to another host do not pass. An "add" comparison needs a
   baseline, and settles on its own only when the baseline fails it; a table's per-record check
   needs an incorrect reference (section 1a).

`selectMined` takes the best decisive candidate per requirement, then, for each incorrect reference
the picks would still judge a success, the best survivor that rejects it.

### 4. The gate, unchanged

The picks are a check set run through `verifyCandidate`, the function `submit_checks` uses, with
full stress testing. A whole set is gated with every reference. A partial set (some requirements
open) is gated with the correct references, because an incorrect reference may fail only on an open
requirement; the merged set is gated in full when the agent submits. A gate error that names a
mined check drops it and the next candidate is tried (four rounds at most). An error naming none
(an incorrect run still judged a success) leaves the picks as they are and hands the problem to the
agent; under `mine-only` it fails the compile.

### 5. Mine-first with the agent

When requirements stay open, the discovery agent starts with:

- only the open requirements in the requirement list;
- the mined checks of the covered ones, with their JSON, as part of every submission (`submit_checks`
  prepends them, so they are gated again with the agent's);
- the top mined survivors per open requirement, and a read-only `mined_candidates` tool with their
  JSON and what each rejects.

The tool and prompt sections exist only under `mine-first`; the default compile's requests, and so
every committed cassette, are unchanged.

### 6. Provenance and report

`compiled.discovery` is `'mined'` (no discovery turn) or `'mined+model'`; absent for the agent alone,
so existing sets are unchanged. Under `mine-only` without a model, `compiled.model` and
`report.model` are `'none'`. `report.mining` gives the strategy, candidates, survivors, variants,
wall time, and per requirement `covered` (with the check) or `open` (with the reason).

## Measurements

`node scripts/mine.ts` (Node 24, no model): every example task (one correct reference, as
`scripts/compile-examples.ts`) and every real-app task (its `reference` runs, as
`eval/real/compile.ts`), twice: with the deterministic rubric (no model at all), and with the
rubric replayed from the task's committed cassette (what `mine-first` sees). Every mined set is
judged on the task's held-out labelled runs. With the set comparisons and synonyms of sections 1a
and 1b (the first numbers are before them):

| Dataset  | Rubric        | Tasks | Compiled mine-only | Requirements covered | Held-out as labelled | False successes | Mining ms (median / max) |
| -------- | ------------- | ----: | -----------------: | -------------------: | -------------------: | --------------: | -----------------------: |
| examples | deterministic |    30 |            11 → 12 |        19/44 → 20/44 |        32/33 → 35/36 |               0 |               8.6 / 56.6 |
| examples | model         |    30 |             9 → 10 |        24/57 → 25/57 |        28/28 → 31/31 |               0 |               4.8 / 29.1 |
| real     | deterministic |    44 |              0 → 4 |          0/44 → 4/44 |            – → 16/16 |               0 |              12.0 / 73.1 |
| real     | model         |    44 |              0 → 2 |         6/84 → 11/84 |              – → 8/8 |               0 |               9.3 / 62.4 |

What the new rules settle: "add" on `wordpress/w09-new-user` (a new user, the other users kept),
`w10-add-tag` (the tag, and the post's other tags kept: the ADR 0011 run that replaced the tags,
`perturbed-replaced-tags`, fails), `prestashop/s02-tshirt-variant` and `s06-wishlist`, with both
rubrics; the synonyms settle `tiny-calendar/04-move-dentist` ("appointment" for the `events` probe,
both rubrics) and `w14-community-category`'s "Create a category" ("category" for the `categories`
probe). Tiny Tracker 10 ("only open issues", "only issues labelled bug") gets its table checks,
which survive and account for every word, but stays open: its `only-bugs` run shows the correct
run's page (section 1a), so a table check needs an incorrect reference, which `scripts/mine.ts`
does not give.

The one held-out miss is an abstain, not a false success: on `09-gift-wrap/spoofed-confirmation`
no order exists, so the probe the mined check reads fails and the check abstains where the model's
set fails. The maximum times are the first task of a process (cold JIT). The `mine` workload of
`scripts/bench.ts` (all 74 tasks, deterministic rubric, mine-only, acceptance gate with its stress
test included) took 314 ms per pass when it was added; with the set comparisons it takes 588 ms
against 521 ms for the code before them on the same machine (median of 7 passes, 7.9 against 7.0
ms per task): four more tasks compile, so four more sets go through the gate's stress test.

**Model savings, from the cassettes.** With the recorded model rubric, 12 of the 74 tasks are
covered by mining (10 example tasks, `w10-add-tag` and `s06-wishlist`). Under `mine-first` they run
the rubric turn only: 33 of the 224 discovery turns (15%), 645 k of 4.86 M input tokens (13%) and
6.6 k of 86 k output tokens (8%) of the committed compiles are not spent (the rubric run's turns, as
recorded in each cassette, are left out of these). For the 16 tasks mining covers in part (20 of
their 52 requirements) the agent still runs, on fewer requirements and seeded; what that saves
needs live runs (its requests differ from the cassettes), so it is not claimed here. The default
strategy is unchanged: the `compile-replay` workload reproduces all 10 committed check sets, and
every committed compile replays byte for byte.

**Why coverage is low on the real apps.** The real-app tasks have no expected outcomes, so the
deterministic rubric is one requirement quoting the whole instruction ("Close the issue "Crash when
uploading empty file" in acme/webapp."), and its content words ("acme", "webapp", "repository",
"back office", the imperative verb) are context no single value accounts for. The model's rubric
splits instructions into parts, which helps a little (11/84). The 169 open requirements over both
datasets and rubrics (180 before sections 1a and 1b), by reason:

| Reason                                                                                                                                                                                                            | Open (before) |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: |
| a content word no survivor accounts for: repository and shop context, page wording ("the cart page lists"), a value word for a field ("going" for `rsvp: "yes"`), a unit ("90 minutes")                           |     108 (113) |
| "add": mixed with another set word or a negation (6), or no before/after comparison survived (4): a value next to a name ("two Mountain fox cushions"), a record the baseline already held without one list field |       10 (21) |
| a set word mining does not express ("the others", "no longer", "every … that has no assignee") (9), no per-record check survived (3), or a table check without an incorrect reference (4)                         |       16 (16) |
| only presence (a request, URL or node) or what a request sent, and no incorrect reference to show it discriminates                                                                                                |       17 (15) |
| no candidate: no evidence holds a value the quote names                                                                                                                                                           |         7 (7) |
| the baseline already passes the best survivor                                                                                                                                                                     |        11 (8) |

The rows that grew are requirements an "add" used to stop first: with the "add" handled, they show
the reason behind it (another user already had `w09-new-user`'s "the Author role", so the
baseline passes it). Each is a requirement mining declines rather than half-checks: across the 28 mined sets and
their 91 held-out runs, mining produced no false success. The request rules (the server's echo, the
origin) cost the most coverage: `tiny-tracker/01-create-bug` and `02-create-high-priority` create
their issue with a form POST the server answers with a redirect, so "the new issue has the bug
label" and "its priority is high" now go to the model, as do the Gitea milestone and PrestaShop
price forms.

## Consequences

- Compiling is cheaper and deterministic where the evidence is plain: a quarter of the requirements
  of the model rubrics (36 of 141) and 12 whole tasks need no discovery model; `mine-only` with the
  deterministic rubric compiles 12 example and 4 real-app tasks with no model at all, in
  milliseconds.
- Mining is deliberately conservative, so on instruction-only tasks it mostly hands requirements to
  the model, seeded. A wrong mined check would be worse than a model turn; the gate, the
  "accounts for the quote" rule and held-out runs are what keep it honest.
- `assay bench` does not compare strategies yet: a bench compile runs the default strategy, and
  comparing `mine-first` with `model` on recorded tasks needs cassettes recorded with the mining
  prompt. Follow-up.
- The synonym table is a reviewed list, not a thesaurus: a word joins it only when a committed quote
  uses it for a field, and it never widens values. Value synonyms ("going" for `rsvp: "yes"`) and
  units ("90 minutes" for `duration: 90`) are left to the model: they would decide which values a
  quote names.
- Follow-ups: a table check made decisive by the filter the page shows (the selected option, the
  URL query) rather than by an incorrect reference; "remove X" / "no longer" as the absence of X
  with the baseline holding it; a11y presence that the stress mutants show to be discriminating
  (today only incorrect references count).
