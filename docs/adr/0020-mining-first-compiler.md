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
crowd out a later `orderShips` probe that accounts for "the order ships express".

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
   one scalar). Words about which page is open ("page", "screen") are accounted for only by tree or
   URL evidence, words about what it presents ("shows", "visible") only by the tree, and a kind of
   element ("button", "checkbox", "heading") only by a candidate whose role names it: a URL check
   never settles "the Checkout button is visible". A word the quote uses twice must be accounted for twice ("the Dentist event is called "Dentist (Dr. Lee)"").
2. **The quote is expressible.** Quotes with "only", "every", "all", "other", "no longer", "keep",
   … speak of a set or an absence, and "add"/"put" also keeps what the collection held (ADR 0011);
   mining builds neither comparison. Words inside quotation marks are names, not quantifiers.
3. **It is evidence of the outcome.** It rejects an incorrect reference, or it compares a value the
   quote names (a stated candidate, with its records identified) and the baseline did not already
   pass it. A request, a URL or a node that is merely present settles nothing without an incorrect
   reference that lacks it. A request body is what the browser asked for, not what happened: a POST
   the server answers with a redirect to its login page sends the same body. So a request-body
   candidate states the outcome only when every reference saw a 2xx answer, and it then requires
   one; after a redirect, it settles nothing without an incorrect reference that fails it. A
   response body is the server's own answer. Every request candidate names the origin the
   references sent it to, so the same path and body sent to another host do not pass.

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
judged on the task's held-out labelled runs.

| Dataset  | Rubric        | Tasks | Compiled mine-only | Requirements covered | Held-out as labelled | False successes | Mining ms (median / max) |
| -------- | ------------- | ----: | -----------------: | -------------------: | -------------------: | --------------: | -----------------------: |
| examples | deterministic |    30 |                 11 |                19/44 |                32/33 |               0 |               5.8 / 47.1 |
| examples | model         |    30 |                  9 |                25/57 |                28/28 |               0 |               2.8 / 14.4 |
| real     | deterministic |    44 |                  0 |                 0/44 |                    – |               – |               6.8 / 26.2 |
| real     | model         |    44 |                  0 |                 6/84 |                    – |               – |               5.3 / 27.8 |

The one held-out miss is an abstain, not a false success: on `09-gift-wrap/spoofed-confirmation`
no order exists, so the probe the mined check reads fails and the check abstains where the model's
set fails. The maximum times are the first task of a process (cold JIT). The new `mine` workload of
`scripts/bench.ts` (all 74 tasks, deterministic rubric, mine-only, acceptance gate with its stress
test included) takes 314 ms per pass, **4.2 ms per task** (median of 7 passes; calibration 43.7 ms
on the same machine). It is new, so the CI comparison reports it as such until `bench/baseline.json`
is re-recorded.

**Model savings, from the cassettes.** With the recorded model rubric, 9 of the 74 tasks are
covered by mining (all of them example tasks). Under `mine-first` they run the rubric turn only: 26
of the 224 discovery turns (12%), 500 k of 4.86 M input tokens (10%) and 4.8 k of 86 k output
tokens (6%) of the committed compiles are not spent (the rubric run's turns, as recorded in each
cassette, are left out of these). For the 14 tasks mining covers in part (18 of their 46
requirements) the agent still runs, on fewer requirements and seeded; what
that saves needs live runs (its requests differ from the cassettes), so it is not claimed here.
The default strategy is unchanged: the `compile-replay` workload reproduces all 10 committed check
sets, and every committed compile replays byte for byte.

**Why coverage is low on the real apps.** The real-app tasks have no expected outcomes, so the
deterministic rubric is one requirement quoting the whole instruction ("Close the issue "Crash when
uploading empty file" in acme/webapp."), and its content words ("acme", "webapp", "repository",
"back office", the imperative verb) are context no single value accounts for. The model's rubric
splits instructions into parts, which helps a little (6/84). The 179 open requirements over both
datasets and rubrics, by reason:

| Reason                                                                                                                                                                                                | Open |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: |
| a content word no survivor accounts for: repository and shop context, page wording ("the cart page lists"), synonyms the miner does not know ("preference" for `settings`, "going" for `rsvp: "yes"`) |  111 |
| "add" also keeps the collection (ADR 0011)                                                                                                                                                            |   21 |
| a quantifier ("every open bug", "only open issues", "keep everything else")                                                                                                                           |   16 |
| only presence (a request, URL or node) or a request answered with a redirect, and no incorrect reference to show it discriminates                                                                     |   16 |
| no candidate: no evidence holds a value the quote names                                                                                                                                               |    7 |
| the baseline already passes the best survivor                                                                                                                                                         |    8 |

Each is a requirement mining declines rather than half-checks: across the 20 mined sets and their
61 held-out runs, mining produced no false success. The request rules (a 2xx answer, the origin)
cost the most coverage: `tiny-tracker/01-create-bug` and `02-create-high-priority` create their
issue with a form POST the server answers with a redirect, so "the new issue has the bug label" and
"its priority is high" now go to the model, as do the Gitea milestone and PrestaShop price forms.

## Consequences

- Compiling is cheaper and deterministic where the evidence is plain: a fifth of the requirements
  of the model rubrics (31 of 141) and 9 whole tasks need no discovery model; `mine-only` with the
  deterministic rubric compiles 11 example tasks with no model at all, in milliseconds.
- Mining is deliberately conservative, so on instruction-only tasks it mostly hands requirements to
  the model, seeded. A wrong mined check would be worse than a model turn; the gate, the
  "accounts for the quote" rule and held-out runs are what keep it honest.
- `assay bench` does not compare strategies yet: a bench compile runs the default strategy, and
  comparing `mine-first` with `model` on recorded tasks needs cassettes recorded with the mining
  prompt. Follow-up.
- Follow-ups: building the "add keeps what is there" comparison from the baseline (ADR 0011), so
  "add" requirements can be mined; `each` candidates for "only"/"every"; synonyms between quote
  words and field names; a11y presence that the stress mutants show to be discriminating (today
  only incorrect references count).
