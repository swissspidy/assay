# ADR 0026: `assay bench` compares discovery strategies, with configurable prices

- Status: Accepted
- Date: 2026-11-09
- Scope: CLI (`assay bench --discovery`, `--prices`), config (`bench.discovery`, `bench.prices`),
  `assay.bench/v1` (additive fields), `examples/bench-strategies`
- Builds on: [ADR 0017](0017-config-file-and-bring-your-own-model.md), [ADR 0018](0018-model-bench.md),
  [ADR 0020](0020-mining-first-compiler.md)

## Context

ADR 0020 added three discovery strategies (`model`, `mine-first`, `mine-only`) and measured what
mining saves from the committed cassettes, but left the bench comparing models only: "comparing
`mine-first` with `model` on recorded tasks needs cassettes recorded with the mining prompt.
Follow-up." Under `mine-first` the discovery agent sees only the requirements mining left open and
a seed of mined checks, so its requests differ from the default compile's and need their own
recordings.

ADR 0018 priced jobs from `PRICING`, the Anthropic list prices keyed by bare model name
(`priceFor` strips the provider prefix, effort suffix and replay marker). Every other model showed
`—`, and a user had no way to give a price.

Both changes must leave the default bench as it is: the committed `examples/bench/REPORT.md`, its
cassettes and every compile replay stay byte for byte the same.

## Decision

### The strategy dimension

`--discovery model,mine-first,mine-only` (comma-separated, repeatable; validated: known strategies,
none twice) or `bench.discovery` in the config, by precedence flag > config > `['model']`. The
bench's own setting is independent of `compile.discovery`: a project that compiles with
`mine-first` still benches `model` unless it asks.

- **Rows.** Each model gets one row per strategy that needs a model, in the order given (model
  major, so a model's strategies sit side by side), then one `mine-only` row. `mine-only` runs
  with the deterministic rubric (one requirement per outcome clause) and mining alone, so it needs
  no model, no key and no cassette, and is the same for every model: its row is labelled `none`.
  A bench of `mine-only` alone needs no models at all.
- **Columns.** A `Discovery` column after `Model`, and three coverage columns after `Compiled`:
  `Req. mined` and `Req. discovered`, the share of the rubrics' requirements that the accepted
  check sets cover with mined checks and with checks the discovery agent wrote, and `No discovery`,
  the share of tasks compiled with no discovery-agent turn. `Compiled` is the accept rate (tasks
  whose checks passed the acceptance gate); the legend says so. The coverage columns are not
  ranked: more mining is cheaper, not better checks, and cost already has its columns. Turns,
  tokens and price are the existing columns, per strategy.
- **The `mine-only` row** shows zero turns, tokens and cost (`$0.0000`: known to be zero, not
  unknown) and `—` for time: mining time is real but varies run to run, and a replayed report must
  not. Stress, balanced accuracy and false successes are measured as for any row, since they are
  free.
- **Rubrics differ.** `model` and `mine-first` rows use the model's rubric, `mine-only` the
  deterministic one, so its requirement counts have a different denominator. The per-task table
  shows `mined, discovered of total` for each job.

### Cassettes

The default strategy keeps its path, `<cassettes>/<slug>/<task>/run-<n>.json`, and its requests, so
every existing cassette replays unchanged. `mine-first` jobs record to
`<cassettes>/<slug>/<task>/mine-first/run-<n>.json` (its timing file beside it): one directory per
strategy under the task, which no `run-<n>.json` name can collide with. `--record` re-records only
the rows asked for, so `--discovery mine-first --record` leaves the `model` cassettes alone.

### Prices

`bench.prices` in the config and `--prices <file.json>` take the same shape, in USD per million
tokens:

```ts
bench: { prices: { 'openai:gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 } } }
```

- **Precedence:** the file, then the config, then `PRICING`. A model id is looked up as
  `provider:model`, then as the bare model name (effort suffix and replay marker ignored), in each
  table in turn: the table decides first, so a file's bare `claude-opus-5-5` beats the config's
  `anthropic:claude-opus-5-5`.
- **Validation:** an object of non-empty keys to objects with `input` and `output` (required) and
  `cacheRead`, `cacheWrite` (optional), each a non-negative finite number; any other key is an
  error that names the entry and lists the allowed keys. A bad config fails to load; a bad or
  unreadable `--prices` file is a command error (exit 4).
- **No invented prices.** A model in no table has no price. A price without a cache rate prices a
  job only if the job used no tokens of that kind; otherwise its cost is unknown and a note says
  which rate is missing. No rate is assumed.
- **Reporting.** When prices were given (config or file) or strategies are compared, the report
  lists every model's price with its source (`default`, `config`, `file`) and the key it matched,
  or `price unknown` (a `## Prices` table in Markdown, one note per model in the terminal, a
  `prices` array in JSON, `price: { key, source } | null` per job), and an unknown cost reads
  `price unknown` in the tables instead of `—`. A default bench keeps ADR 0018's `—` and "no price
  listed" note, so its output is unchanged.

### Output

`assay.bench/v1` gains optional fields only, present only when they apply: `discovery` and
`prices` at the top; per row `discovery`; per job `discovery`, `discoveryTurns`, `requirements`
(`{ total, mined, discovered }`) and `price`; per summary `requirementsMined`,
`requirementsDiscovered` and `noDiscovery`. A `mine-only` job has `source: 'none'`, no `modelId`
and no `price`. The default bench's JSON has none of them.

### Fixture

`examples/bench-strategies/` benches Claude Opus 5.5 (the model of `examples/bench`, through
Assay's Anthropic adapter, `models/claude.ts`) with all three strategies on three tiny-shop tasks:
`01-newsletter`, `02-add-blue-mug` and `07-express-order`. The `model` cassettes are the
`scripts/compile-examples.ts` recordings, copied; the `mine-first` cassettes were recorded live
with `--record` (one run, $0.33 at list prices; an earlier attempt through the AI SDK provider,
discarded because it did not use prompt caching and so did not compare like for like, cost
$0.57). The tests and the package test replay it and compare `REPORT.md` byte for byte.

| Discovery  | Compiled | Req. mined | Req. discovered | No discovery | Bal. acc | False success | Turns | Tokens in | Cost / task |
| ---------- | -------: | ---------: | --------------: | -----------: | -------: | ------------: | ----: | --------: | ----------: |
| model      |     100% |         0% |            100% |           0% |    1.000 |            0% |   3.7 |     54.0k |     $0.1349 |
| mine-first |     100% |        50% |             50% |          33% |    1.000 |            0% |   3.0 |     44.5k |     $0.1087 |
| mine-only  |      33% |        17% |              0% |          33% |    1.000 |            0% |   0.0 |         0 |     $0.0000 |

Mining settles `02-add-blue-mug` outright (the rubric turn only, $0.0078 instead of $0.1242) and
three of `07-express-order`'s five requirements, leaving two to the agent; on `01-newsletter` it
settles nothing and the agent runs as before. Three tasks and one run are a fixture, not a
measurement: live recordings differ run to run, and the `model` cassettes were recorded on an
earlier day.

## Consequences

- One report answers "how much does mining save on my tasks, and does it cost check quality",
  per model, and replays in CI without keys.
- Any model can have a cost, and a report never shows `$0` for a price nobody gave.
- Recording `mine-first` costs a live run per model and task; `mine-only` costs nothing.
- The default bench, its fixture report, its cassettes and every compile replay are unchanged.
