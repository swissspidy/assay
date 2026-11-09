# ADR 0022: `assay status`, the readiness ladder

- Status: Accepted
- Date: 2026-11-09
- Scope: `assay status`, `status()` and `formatStatus()` in `@swissspidy/assay`, config
  (`status`), `examples/status`, `scripts/status-fixture.ts`
- Builds on: [ADR 0013](0013-review-workflow-and-signed-locks.md), [ADR 0015](0015-evidence-store-and-compiled-checks.md),
  [ADR 0016](0016-overlay-stress-and-capture-digests.md), [ADR 0017](0017-config-file-and-bring-your-own-model.md),
  [ADR 0019](0019-typed-checks-matcher-and-watch.md)

## Context

A team with many tasks wants one view of which are ready for production and what blocks the
rest. Every step a task goes through already exists: `validate`, the coverage warnings, `review`
and `approve` (signed locks), `stress`, and verifying labelled runs (`watch --once`). Each answers
for one aspect, in its own output and exit status, so the question "where is each task, and what
is next?" means running five commands per task and reading them together. Kore.ai's Autoloop
answers it with a readiness ladder: ordered stages, each passing before the next is tried, each
naming its blocker.

## Decision

### The ladder

One row per task (a check set; its name is the file name without `.checks.json` / `.checks.ts`),
with these stages in order:

| Stage        | Passes when                                                                                                       | Blocker                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `valid`      | the set loads and validates                                                                                       | the first validation error (or the load error), `(+n more)`                                    |
| `covered`    | every hard requirement has a check, and not only checks the validator warns read free page text                   | `R2 has no checks`, `R2 is checked by free page text only (C2)`                                |
| `locked`     | a lock verifies on the set as it is now; with trusted keys, it is signed by one of them                           | `not locked`, `rejected by bob: …`, `changed since lock: check C1 changed`, `untrusted key: …` |
| `stress`     | no valid variant of a correct run is rejected                                                                     | `C1 fails on variant <run>/<variant>`, `no correct reference run to stress-test`               |
| `references` | every labelled run is judged as labelled                                                                          | `<run>: FAIL, expected success (C2 fail)`, `<run>: ABSTAIN, expected fail`                     |
| `recent`     | at least `minPassRate` of the newest `last` runs in `<snapshots>/<task>/` succeed (default: all of the newest 10) | `2/3 recent runs succeed; <run>: FAIL (C1 fail)`                                               |

A stage is evaluated only when every stage before it passed; the later ones are `not-reached`
and cost nothing (a set that is not locked reads no runs). A stage that is not part of the ladder
(`--no-stress`, `status.stages`, or `recent` without a recent-runs root) is `skipped` for every
task; `recent` is also skipped for one task with no recent runs. Skipped stages do not block. A
task is **ready** when no stage failed or went unreached. The set is loaded and validated first
whatever the ladder: without `valid` in it, a set that does not validate fails the first stage
that is, with `invalid check set: …`.

Choices inside the stages, and why:

- **Covered is about hard requirements.** They decide the verdict: an uncovered hard requirement
  makes every run abstain. A soft requirement without a check is a review note, not a blocker.
  "Free text only" reuses the validator's warning (`reads free page text`): a requirement is
  blocked when every one of its checks drew it. One free-text check among others is the
  reviewer's call, as it is today. The warning is drawn only by a `text` source that reads the
  whole document: one with a `scope`, or inside an `each` record, reads that node's text, which
  is derived from accessible names, as the evaluator reads it (ADR 0001 §2.6).
- **Locked follows `validate --require-signed`.** With trusted keys (`--trusted-key`,
  `ASSAY_TRUSTED_KEYS`, the config's `trustedKeys`, in that precedence), only a lock signed by one
  of them passes; without any, any lock that verifies passes and its signature is reported as not
  checked. A broken lock names what changed from the per-item digests (`describeChange`), or the
  first problem when the lock itself was edited. A rejection of the current content names the
  reviewer and the note.
- **Stress gates on valid variants only.** "Stress-clean" means a correct run edited in ways that
  must not matter is still accepted: an over-constrained or fragile check rejects real correct
  runs in production. Weak checks and missed mutants are quality findings the reviewer saw on the
  review sheet when locking (ADR 0013); gating on them would make the ladder disagree with an
  approval. So the stage runs the overlay stress test (ADR 0016) without success-claim mutants,
  which it does not read. Runs labelled `fail` are not stress-tested, as in `assay stress`;
  unlabelled runs are.
- **A correct run the checks reject is a references blocker, not a stress one.** The stress test
  reports it as the pseudo-variant `reference`; the stage leaves it to the next one, whose blocker
  names the run and the check that failed it. The order the motivation gives is kept (references
  after stress), so a task whose correct run fails still shows "stress ✔" when the variants of its
  other correct runs pass.
- **References need a labelled correct run.** Zero labelled runs would pass vacuously; a task
  nobody has a correct run for is not ready. An unreadable run file is the stage's blocker. A
  run labelled `fail` must get the verdict `fail`, as `assay watch` judges "as expected": an
  abstain shows the checks could not tell, not that the run is wrong. (`assay bench` scores an
  abstain on a negative run as correct for balanced accuracy; the gate takes the stricter rule.)
- **Recent runs are the newest by `capturedAt`**, compared as instants (so UTC offsets order
  correctly; ties by file name, newest first), because file modification times change on
  checkout. A run that cannot be read, or whose `capturedAt` is missing or not a date, fails the
  stage before the window is taken, so a truncated capture is never silently left out. A run passes when its verdict is `success`; labels are
  not read there, since recent runs are production evidence, not curated references. The blocker
  names the newest failing run.

Runs are discovered as `assay watch` and `assay bench` discover them (ADR 0019): `<dir>/<task>/`
for each `--reference` directory (default: the config's `bench.references`) and `references/`
next to the set's directory. `discoverSets` and `runDirsFor` moved from `watch.ts` to
`checks/load.ts`, where both commands import them. Recent runs live under the config's
`snapshots` (where `assay capture` writes), in `<snapshots>/<task>/`. Runs are read once per
directory: a directory that is both a references and a recent-runs directory is read once and
judged by both stages.

### Output and exit status

- The table has one column per evaluated stage, marked `✔` passed, `✘` failed, `–` not reached,
  `·` skipped, and a last column with the blocker of the stage that failed (`ready` otherwise).
  Two tasks with the same name show their file paths. Padding is computed before colour, which
  is used only when `io.color` is set. A summary line follows: `12 tasks: 1 ready, 1 blocked at
  valid, 2 at covered, …`, stages in ladder order. Nothing in the table depends on time or the
  machine, so a committed table can be compared byte for byte.
- `--json` prints `assay.status/v1`: `{ schema, stages, tasks, summary }`. Each task has `name`,
  `file` (relative to the current directory), `checkSet` once valid, `ready`, `blockedAt` and
  `blocker` when blocked, `stages` (all six, in ladder order, each `{ status, blocker?, detail? }`)
  and `runs` (`references`, `recent`: how many were read). Keys are written in a fixed order.
- `--stage <name>` exits 1 unless every task got through that stage (it and every stage before it
  passed or were skipped), so CI can require "every task is locked" with `--stage locked`. A stage
  that is not evaluated (`--stage stress --no-stress`, `--stage recent` without `snapshots`) is a
  usage error, not a silent pass. Without `--stage`, the exit status is 0 unless there is a usage
  (3) or other error (4), such as a check set path that does not exist.

### Configuration and API

`status: { stages?, recentRuns?: { last?, minPassRate? } }` in `assay.config.ts`. `stages` is the
project's ladder (a project that does not review sets can leave out `locked`); `--no-stress` and
`--stress` override it for the stress stage, following flags > environment > config > defaults
(ADR 0017). `status(options)` is the engine and `formatStatus(result, { color })` the table, both
exported from the root with their types (`StatusOptions`, `StatusResult`, `TaskStatus`,
`StageResult`, `StageStatus`, `StatusStage`, `STATUS_STAGES`). Like `verify`, `status()` reads a
config only when given one (`config: 'assay.config.ts'`, relative to `cwd`, or an object); explicit
options win, and `recentRuns` is checked against the config's bounds. Relative check globs keep
`cwd` literal (`escapeGlob`), as `gate()` does.

### Speed

Each run file is read and its snapshot built once per task, and the same object serves the
stress test and `verifyMany`, so its evidence store and the set's compiled plan (validation,
lock status, prepared checks) are built once (ADR 0015). `verifyMany` runs each check across all
of a task's runs in turn, with `config: false` (no escalation, no records written). Stages after
a failure are not evaluated.

Measured on a 4-core 2.1 GHz Xeon with Node 24 (`node src/cli/index.ts status …`, a fresh process
each time, median of 7; `status()` in one process, first call and the median of six more):

| Check sets                                            | Tasks | Runs read | `assay status` | `--no-stress` | `status()` first / warm |
| ----------------------------------------------------- | ----: | --------: | -------------: | ------------: | ----------------------: |
| `examples/status` (the fixture)                       |    12 |        25 |         598 ms |        596 ms |          166 ms / 31 ms |
| `examples/tiny-{shop,tracker,calendar}` as committed  |    60 |         0 |         662 ms |        653 ms |           99 ms / 21 ms |
| the same 60 sets, each locked (every stage evaluated) |    60 |       247 |        1119 ms |        834 ms |         482 ms / 240 ms |

`assay --version` takes 132 ms, and loading the library (the root's module graph, which
`verifyMany` brings in) about 400 ms of every `assay status`; the ladder itself is 0.1 to 0.5 s.
The committed examples stop at `locked` (none is approved), so they read no runs. With every set
locked, every stage runs for 59 tasks: about 8 ms per task, of which stress (variants only) is a
quarter; the rest is reading and parsing 247 snapshot files, compiling the sets' JSON Schemas and
`verifyMany`, records included.

### Fixture

`examples/status` holds twelve tasks built from tiny-shop's by `scripts/status-fixture.ts`, one
stopped at each blocker: invalid, uncovered, free text only, not locked, changed since lock,
untrusted key, unsigned with trusted keys, a rejected stress variant, no runs, a mislabelled
reference, a failing recent run, and one ready task. Its labelled runs are copied into `runs/`
(the config's `bench.references`) rather than a `references/` directory, which would make
`scripts/bench.ts` take it for an example app. `STATUS.txt` is its table; a unit test and
`npm run test:pack` (from the installed executable) compare it byte for byte, as `assay bench`'s
`REPORT.md` is checked.

## Consequences

- One command answers "which tasks are ready, and what is next for the rest", and one flag turns
  any rung into a CI gate. It changes no check set, verdict, stress report, lock or record; the
  equivalence golden, compile replays and the bench report are unchanged.
- The ladder's order is a policy: a set must be locked before its stress and reference results
  are shown. A team that wants those first can drop `locked` from `status.stages`, or run
  `assay watch --once --stress`, which shows every run regardless.
- Stress here is a narrower gate than `assay stress`, whose exit status also counts weak checks
  and missed mutants. Both are right for their question; the ADR names the difference so a
  ladder that passes stress is not read as "no stress findings".
- On the committed examples, `assay status examples/tiny-shop` first reported
  `R4 is checked by free page text only` for the compiled `08-delivery-date`. That was a false
  positive of the validator, which warned about every `text` source: the check reads the date
  from the text of an "Order summary" paragraph found with `each`, which is accessibility-tree
  evidence. The warning now follows the evaluator's rule, and the task passes `covered`.
