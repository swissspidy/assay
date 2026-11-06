# ADR 0019: Writing and running checks: the typed builder, `toHaveCompleted` and `assay watch`

- Status: Accepted
- Date: 2026-11-06
- Scope: `@swissspidy/assay/checks` (its own entry point only), `*.checks.ts` in the CLI,
  `assay checks print`, `expect(page).toHaveCompleted()` in `@swissspidy/assay/playwright`,
  `assay watch`
- Builds on: [ADR 0001](0001-evidence-snapshot-and-check-dsl.md), [ADR 0010](0010-command-line-tool.md),
  [ADR 0015](0015-evidence-store-and-compiled-checks.md), [ADR 0017](0017-config-file-and-bring-your-own-model.md)

## Context

Check sets are JSON. That is right for what the compiler writes and reviewers lock, but a person
writing or fixing checks by hand gets no completion, no type errors, and no help with the verbose
parts (a JSON Schema for "the cart has a line named Blue Mug", a request match, a normalizer
chain). Running checks is also slower than it needs to be: in a Playwright test, `expectOutcome`
throws an error that is not an `expect` assertion, and the loop "edit a check, verify every run
again" is a shell loop over `assay verify`.

## Decision

Three additions. None changes the DSL, the snapshot, or what any check concludes.

### The check builder

`@swissspidy/assay/checks` exports small functions whose result is exactly `assay.checks/v1`:

| Builder                                                                                                                                                                          | DSL                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `checks(task, [req(...)...])`                                                                                                                                                    | the set; `task` is the instruction or `{ id, version, instruction, outcomes, compiled, locked, rejected }` |
| `req(id, text, { quote, kind, field })`, `.check([description,] assertion, options)`                                                                                             | a requirement and its checks; `check(requirementId, …)` for sets whose checks are not grouped              |
| `node(target)` / `node(role, name)`, `anchors(...)`                                                                                                                              | a target                                                                                                   |
| `.state({...})`, `.checked()`, `.hasText(m)`, …                                                                                                                                  | `state`                                                                                                    |
| `contains(match, opts)`, `node(scope).contains(match)`                                                                                                                           | `contains`                                                                                                 |
| `each(match, assertion, opts)`, `node(scope).each(...)`                                                                                                                          | `each`                                                                                                     |
| `url('/path')`, `url({...})`; `page(match, assertion)`; `allOf(...)`, `anyOf(...)`                                                                                               | `url`, `page`, `allOf`, `anyOf`                                                                            |
| `network.post(url)` … `.status()`, `.requestBody()`, `.responseBody()`, `.count()`                                                                                               | `request`                                                                                                  |
| `node(t).text()`, `text(/re/, opts)`, `url.part()`, `url.param()`, `storage.local()`, `probe()`, `network.post(url).response('/ptr')`, `value(source)`                           | a value source                                                                                             |
| `.normalize('trim', norm.number('en-US'), …)`                                                                                                                                    | `normalize`                                                                                                |
| `.equals()`, `.oneOf()`, `.contains()`, `.matches(/re/)`, `.approx()`, `.gt()`…`.range()`, `.schema()`, `.like()`, `.exists()`, `.sameAs(value, { tolerance })`, `.compare(raw)` | comparisons                                                                                                |
| `like(shape)`, `matching(schema)`                                                                                                                                                | a JSON Schema from an example shape                                                                        |

Rules that keep it honest:

- **The output is plain data.** `checks()` returns the JSON (builders are serialized, undefined
  fields dropped), so validation, `verify`, compiled plans, stress testing, locks and the review
  sheet see no difference. Every function also accepts the plain DSL object where a builder goes,
  so nothing the DSL can say is out of reach.
- **Defaults are explicit in the output.** A requirement's kind is `hard`, its quote its text,
  its field the instruction if the quote is in it (else the outcomes); a check's id is `C<n>` by
  position, its description `describeAssertion` (the review sheet's mechanical rendering); a set's
  id is a slug of the instruction, its version `1`. Validation still reports a quote that is not in
  the task.
- **`like(shape)`** is the only new vocabulary: an object must have the shape's keys (others
  allowed), an array must contain an item like each element (in any order), anything else must
  be equal (`const`); `matching(schema)` puts a schema inside a shape. It produces ordinary JSON
  Schema, so the stored set is unchanged in kind.
- The builder is its own entry point (no Playwright, no model code; it imports the review
  sheet's `describeAssertion` for default descriptions). The root does not re-export it, so its
  generic names (`text`, `node`, `value`, `page`, …) stay out of the root API.

### Modules as check sets, and `assay checks print`

A check set file is `*.checks.json` or a module (`.ts`, `.mts`, `.js`, `.mjs`) whose default export
is a set, or a function returning one. `loadCheckSetFile` loads both; TypeScript runs through
Node 24's type stripping, so a module uses erasable syntax only. Every command that takes a check
set takes a module: `verify`, `validate` (including the config's `checks` directory, now
`**/*.checks.{json,ts}`), `review` (and `--diff`), `stress`, `compile` (its task), `bench` (task
discovery), `watch`. A module that throws, does not parse or exports nothing is reported by
`validate` as invalid, like JSON that does not parse.

`approve`, `reject` and `unlock` never rewrite a module: they refuse unless `--out` names a JSON
file. The module stays the source; the approved JSON is the reviewed artifact.

`assay checks print <file>` prints the set as JSON; with `--ts`, as builder code whose default
export is deep-equal to the set. The printer checks itself by construction: for each construct it
computes the builder call's result and compares it with the input, and prints the plain object
where they would differ in any way (it never does for the committed sets). A test prints all 105
committed check sets, evaluates the modules and compares them deep-equal, and typechecks them.

### `expect(page).toHaveCompleted(task, options)`

`assayMatchers` for `expect.extend`, and a ready `expect`, in `@swissspidy/assay/playwright`.
`task` is a set (JSON or builder) or a path (relative to the current directory; modules load once
per file version). It is `expectOutcome` as a matcher: the same polling (`pollOutcome`, now shared),
the project config (ADR 0017), escalation only once polling settles (`escalate`, `verifier`), and
the same attachments. Differences:

- `timeout` defaults to the expect timeout, so `expect.configure` and the config's `expect.timeout`
  apply.
- `.not` polls until the verdict is anything but `verdict` (default `success`), and passes on
  `fail` or `abstain`; to require a fail, `verdict: 'fail'`.
- The failure message is per requirement: its status, and under each check that did not pass, its
  description, what it tests (`describeAssertion`), what it read (the evidence values, or "nothing
  matched"), why (`reason: message`), and where (the evidence locator and channel in the attached
  snapshot). Passing requirements take one line.
- An invalid or missing check set is an error, not a verdict.

### `assay watch`

Watches check sets (positional files, directories or globs, else the config's `checks`) with
`fs.watch` (recursive), debounced (`--debounce`, 100 ms). The runs of a set named `<name>` are the
`.json` files in `<root>/<name>/` for each run root: `--reference`, else the config's
`bench.references` and `snapshots`, plus `references/` beside the set's directory (the layout of
`examples/*` and `assay bench`). On a change:

- a set file → that set; a file under a set's run directory → that set; anything else (a helper
  module, shared data) → every module set; new sets are added, deleted ones dropped;
- each affected set is loaded (a module in a fresh Node process, so edits to modules it imports
  are seen), validated, and its runs verified with `verifyMany` (no model, no lock, no config
  escalation); snapshots are cached per file version, so their evidence stores are reused;
- `--stress` stress-tests the set against its correct runs, as `assay stress` counts problems;
- the table is redrawn (on a terminal; `--no-clear` appends): per set its state, per run its
  verdict, its label and what changed since the previous round (`was SUCCESS · C1 pass→fail`).

Ctrl-C closes the watchers and exits 0. `--once` prints one table and exits 1 when a set is invalid
or a labelled run is not as expected, which makes it a one-line CI check for a task directory. It is
dependency-free.

## Consequences

- Handwritten checks get types and completion, and the ones the compiler writes can be moved to
  TypeScript mechanically and back. Compiled and locked sets stay JSON.
- A TypeScript set runs code when loaded. It is the project's own code, loaded like
  `assay.config.ts`; `validate --require-locked` and `verify --require-locked` still require a
  lock, which only a JSON set can carry in practice.
- Two ways to write a set means two shapes in review. The review sheet and the JSON are the same
  for both; `assay checks print` shows the JSON of a module.
- Verification, compilation, every committed check set, cassette and report, and the equivalence
  golden are unchanged.
