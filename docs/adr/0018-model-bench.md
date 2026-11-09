# ADR 0018: `assay bench`, comparing models on your own tasks

- Status: Accepted
- Date: 2026-11-06
- Scope: CLI (`assay bench`), config (`bench`), `priceFor` in `@swissspidy/assay/eval`
- Builds on: [ADR 0005](0005-evaluation-and-stability.md), [ADR 0010](0010-command-line-tool.md),
  [ADR 0017](0017-config-file-and-bring-your-own-model.md)
- Extended by: [ADR 0026](0026-bench-strategies-and-prices.md) (discovery strategies, configurable prices)

## Context

ADR 0017 lets a project use any model, so the next question is which one. The published numbers
(ADR 0005, ADR 0009) were measured with one model on the example and real-app datasets, through
repository scripts (`scripts/compile-examples.ts`, `scripts/eval.ts`) that know those datasets'
layouts. A user deciding between, say, Claude Opus, GPT-5 and a local model needs the same
measurements on their own tasks, from one command, and in CI without paying for every run.

## Decision

`assay bench` compiles every task of the project with every model, then measures the compiled
check sets with the machinery Assay already has. Nothing in compilation or verification changes.

### Tasks

A task is a `*.checks.json` or `*.task.json` file under `bench.tasks` (default: the config's
`checks`), read exactly as `assay compile <file>` reads it (same id rule, instruction, outcomes,
`skipVariants`), so a bench compile sends the same requests as that command. Its runs are the
`.json` files in `<references>/<task name>/` (default `references/` next to the tasks directory),
in the labelled format the examples already use (`{ "label": { "expected" }, "snapshot" }`).

Which runs a task compiles from:

1. the runs its task file names in `"references": ["…"]`;
2. else runs named `reference` or `reference-*` (the real-app convention, ADR 0009, ADR 0011);
3. else its first correct run by file name.

Every other labelled run is **held out** and scores the compiled checks, as in the evaluation
(ADR 0005): no model is ever scored on a run it compiled from. Unlabelled runs that are not
compiled from are ignored, since they cannot be scored. A task without runs is skipped with a
message.

### What is measured, per model

| Column        | Meaning                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Mode          | `tools`, `json` or both (ADR 0017), from the compile reports                                                       |
| Compiled      | share of tasks the model compiled (a refusal and an error both count as not compiled)                              |
| Stress ok     | share of compiled check sets with no stress-test problem, as `assay stress` counts them (`problems()`)             |
| Bal. acc      | balanced accuracy of the compiled checks on the held-out runs (`metrics()` from `/eval`)                           |
| False success | incorrect held-out runs judged success (1 − TNR): the error that matters most for a verifier                       |
| Turns         | model turns per task (rubric + discovery, plus escalation with `--escalate`)                                       |
| Tokens in/out | per task, as the model reported them                                                                               |
| Cost          | per task, from `PRICING` (`priceFor` strips the provider prefix, effort suffix and replay marker); `—` if unlisted |
| Time          | wall time of a compile per task; for a replay, the time recorded with it (`—` if none was)                         |

Agreement is computed over the held-out runs of the tasks a model compiled; the Compiled column
shows how many that was. `--escalate` also sends held-out runs the checks abstain on to the same
model as agentic verifier (the `checks+escalation` system of ADR 0005) and adds an Escalated
column. With `--runs N` every job repeats N times; each column shows the mean over repeats and
the sample standard deviation (`±`).

The best value in each column is marked `*` in the terminal (bold and green as well, with colour)
and **bold** in Markdown, so it does not rely on colour. Values are compared as displayed: a
column where every model shows the same value marks none, and so does a bench with one model.

### Output

- A terminal table: one row per model in the order given, then a legend and notes (refused
  compiles, stress problems, errors, what was replayed, what has no price or time).
- `--json`: the full result (`assay.bench/v1`): tasks, and per model its summary and every job
  (status, reason, turns, usage, cost, time, stress rates, each held-out verdict). Unmeasured
  values are `null`.
- `--out <file>`: a Markdown report with the table, the tasks and a per-task breakdown.

Order is fixed: models as given, tasks by name, repeats ascending, whatever order jobs finish in.
Paths in reports are relative to the config's directory, and nothing reads the clock, so a
replayed bench prints the same bytes from any directory and at any concurrency.

### Models

By precedence: `--model` (repeatable), then `bench.models`, then the one model `assay compile`
would use (`ASSAY_MODEL`, the config's `model`, Claude with `ANTHROPIC_API_KEY`). A model is any
ADR 0017 form; on the command line, a `"provider:model"` string or a path to a module whose
default export is a model or an adapter (`./my-adapter.ts`, run through Node's type stripping).
In the config an entry may also be `{ name, model, options }`. The config's `modelOptions`
(except `id`) apply to each. A model is resolved only when a job runs live, so a replay needs
neither keys nor provider packages.

### Cassettes

Each (model, task, repeat) is one job with one cassette:
`<cassettes>/<model slug>/<task>/run-<n>.json` (default directory `assay-bench/`; the slug is the
module's file name for a path, else the label with other characters replaced by `-`). Compile
and escalation turns share it; turns are keyed by request digest as before. `--record` records
live and writes `run-<n>.timing.json` with the wall time next to it, so a replay can show it.

- Without `--record`: an existing cassette is replayed, else the job runs live and records
  nothing (like `--cassette`, ADR 0010).
- `ASSAY_MODEL_MODE=replay`: never call a model; a missing cassette is an error in that model's
  row. `ASSAY_MODEL_MODE=record` is `--record`.

A request a cassette has no recording for is reported as a stale cassette, not as a refused
compile.

### Running

Jobs run interleaved (each repeat, each task, each model) with at most `--concurrency` (default 2) at once, so a stopped bench has results for every model. A job never throws: an error (a
missing provider package, an API error, a stale cassette) is its result. A model whose every job
errored shows `error` in its row and the message below the table; the other models go on. Ctrl-C
stops starting jobs and prints what finished, marked as partial; jobs still in flight are
abandoned and the process exits.

Exit status: 0 done, 1 a model or a compile errored (so CI notices a stale cassette), 3 usage,
4 other error, 130 interrupted.

### Fixture

`examples/bench/` is a bench over two tiny-shop tasks with two models, committed with its
cassettes and `REPORT.md`:

- `anthropic:claude-opus-5-5`: the recordings `scripts/compile-examples.ts` made for these tasks,
  copied unchanged. The task files carry the ids and compile references that script used, so the
  bench replays them request for request.
- `./models/copycat.ts`: a custom adapter without tool calling (driven in JSON mode) that
  proposes the handwritten requirements and checks, recorded with `--record`. It has no price.

The tests replay it and compare the report byte for byte, from two directories; the package
test does the same from the installed executable.

## Consequences

- One command answers "which model should compile my checks, and at what cost" on the project's
  own tasks, and CI can replay it without keys.
- Bench numbers are only as good as the labelled runs: a task with no incorrect held-out run
  cannot show a false success. The table shows how many held-out runs scored the checks.
- Cost covers only models in `PRICING` (Anthropic list prices). Other models show `—` until the
  table grows or takes user prices.
- Time in a replay is whatever was recorded; cassettes from `compile-examples.ts` have none.
- Verification, compilation and every committed check set, cassette and report are unchanged.
