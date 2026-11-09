# ADR 0021: `assay gate`, an agent regression gate

- Status: Accepted
- Date: 2026-11-09
- Scope: CLI (`assay gate`), `gate()` and its formatters in `@swissspidy/assay`, config (`gate`),
  `examples/gate`
- Builds on: [ADR 0015](0015-evidence-store-and-compiled-checks.md), [ADR 0017](0017-config-file-and-bring-your-own-model.md),
  [ADR 0018](0018-model-bench.md), [ADR 0019](0019-typed-checks-matcher-and-watch.md)

## Context

An agent changes: its prompt, model, tools or code, edited by a person or proposed by an
optimizer. Before the change ships, a team wants to know whether any task got worse. Optimizers
such as Kore.ai's Autoloop use one rule: keep a change only if it improves things and regresses
nothing. Applying that rule needs a judge that gives the same answer every time and says why.

Assay already has the parts. Check sets judge outcomes from captured snapshots with deterministic
checks, `verifyMany` runs one set over many runs (ADR 0015), and runs are laid out as
`<dir>/<task>/*.json` by `references/`, `assay bench` and `assay watch` (ADR 0018, ADR 0019).
What is missing is the comparison of two sets of runs.

## Decision

`assay gate --baseline <dir|glob> --candidate <dir|glob> [checks...]` verifies both sides with
the same check sets and classifies every task and requirement. `gate(options)` in the package root
does the same for a program; the command is a thin wrapper around it.

### Inputs

- **Sides.** Each side is one or more directories (or globs of directories), each holding one
  directory of `.json` snapshots per task: `<dir>/<task>/*.json`, the `references/` layout.
  Several directories pool their runs per task (CI shards, repeated captures). Labels in run files
  are ignored: every run is a run of the agent. `gate()` also takes the runs in memory,
  `{ [task]: snapshots }`.
- **Check sets.** Matched to tasks by name, as bench and watch do (`02-add-blue-mug.checks.ts`
  judges `<dir>/02-add-blue-mug/`): the positional files, directories or globs, else
  `gate.checks`, else the config's `checks`. A side directory may also hold `<task>.checks.json`
  (or `.ts`) next to `<task>/`: the set that side was judged with, which wins over the shared one
  for that side.
- **One set per task.** Both sides of a task must come to the same set by content digest
  (`contentDigest`: the set without its lock or rejection, so approving a set changes nothing). If
  they differ, the gate stops with exit 4 and names both files and digests: a difference in the
  checks would read as a difference in the agent. The fix is to judge both sides with one set.

No model runs, by construction: `verifyMany(set, runs, { config: false })`, with no verifier and
no escalation, whatever the config says.

### Classification

For each task, the outcome (successes) and each requirement (passes) are counted per side, with
the runs that failed and abstained. **Abstain counts as not passing**: a run the checks could not
decide is not evidence that the agent did the task, and the report says so.

With `bp` of `bn` baseline runs and `p` of `n` candidate runs passing, the baseline's rate is
scaled to the candidate's run count, `bp × n / bn`, and compared with `p`:

- **regressed**: `p` is more than `--tolerance` runs below it (`bp·n − p·bn > tolerance·bn`);
- **improved**: `p` is more than `--tolerance` runs above it;
- **unchanged**: otherwise.

Multiplied out, a whole-run tolerance compares integers, so the rule is exact and the same runs
always give the same answer. With equal run counts it reads "the pass count dropped by more than
the tolerance"; the default tolerance is 0, so any drop is a regression. A drop from success to
fail or abstain in a single run is a drop from 1 of 1 to 0 of 1.

A task is **regressed** when its outcome or any requirement regressed (an improvement elsewhere
does not offset it), else **improved** when anything improved, else **unchanged**. A task only
the candidate ran is **new**; one only the baseline ran is **missing**, and so are its
requirements. A task directory with no runs counts as not run, and is listed under skipped.

### Blocking and `--allow`

Exit 1 when anything blocks: a regressed requirement, a regressed outcome, or a missing task. A
missing task blocks because a task the candidate did not run cannot be shown not to regress (a
crashed shard must not pass the gate). New tasks never block.

`--allow <rule>` (repeatable, or `gate.allow`) marks known-flaky work as non-blocking:
`<task>` allows the whole task, `<task>:<requirement>` one requirement; each part is a glob. An
outcome regression is allowed when the task is, or when every hard requirement whose pass rate
dropped is allowed: a flaky requirement must not block through the verdict it lowers. Allowed
regressions are still classified, shown (`!` and "(allowed)") and explained in the report.

`--min-runs n` (default 1) is the fewest runs a side may have for a task it ran; fewer is exit 4
listing the tasks, since a pass rate from too few runs says little.

### Errors

Exit 3 for usage (no baseline or candidate, a bad number); exit 4 for input the gate cannot judge:
a side that does not exist or has no runs at all, check sets that differ between the sides, an
invalid check set, too few runs, or no task with both runs and a check set. A task with runs but
no check set is skipped and listed, not an error, so a side can hold tasks the checks do not
cover yet; it never counts as passing.

### Output

- **Terminal.** A headline (tasks, runs, tolerance), then a table: a mark (`✘` blocks, `!`
  allowed, `✔` improved, `+` new, `·` unchanged), the task, its change, successes `baseline →
  candidate` and the requirements that changed (`R1 2/2 → 1/2`). Changed tasks come first
  (regressed, missing, improved, new), then unchanged ones, by name within each. Under it, one line
  per regression with the first failing check, its message and the run, then skipped tasks and the
  verdict sentence. The table is `alignTable`, shared with `assay bench`.
- **`--json`**: the `GateResult` (`assay.gate/v1`): options, per side its sources and run count,
  the summary, per task its check set (id, version, digest, file), status, blocking and allowed
  flags, outcome and requirement counts, findings, and every run's verdict and requirement
  statuses. Keys come in a fixed order.
- **`--markdown <file>`**: a report to post on a pull request. The verdict, the rule in one
  sentence, the table, then one section per regressed requirement: its counts on both sides, the
  first candidate run that did not pass it (and the others), and for each of its checks that did
  not pass, what it expected (the review sheet's `describeAssertion`), what it found (the evidence
  locators and values), the result and its message, and what the same check found in a baseline
  run where the requirement passed. A reviewer sees why a task regressed, not only that it did.
  Then tasks on one side and skipped tasks.

Paths are relative to the config's directory (else the current directory) and nothing reads the
clock, so the same runs print the same bytes from anywhere.

### The API

`gate(options): Promise<GateResult>` takes `baseline`, `candidate` (paths or runs in memory),
`checks` (paths or sets in memory), `tolerance`, `minRuns`, `allow`, `cwd` and `relativeTo`, and
throws `GateError` for input it cannot judge. It reads no config file; the CLI applies the config
(flags > config > defaults, ADR 0017; there are no gate environment variables). An optimizer's
acceptance function is one line: `(r) => r.ok && r.summary.improved > 0`. `formatGate`,
`formatGateMarkdown`, `gateJson` and `classifyCounts` are exported with it.

### Config

`gate: { baseline, candidate, checks, allow, tolerance, minRuns }`, paths relative to the config
file. Flags replace config values (`--allow` replaces `gate.allow`, it does not add to it).

### Fixture

`examples/gate/` holds two runs per task per side, copied from the tiny-shop references:
`02-add-blue-mug` regresses (one candidate run adds the Red Mug), `07-express-order` improves (one
baseline run placed a standard order), `01-newsletter` is unchanged and `09-gift-wrap` is new. Its
config points at `../tiny-shop/tasks`. `REPORT.md` is the committed report; the tests and the
package test reproduce it byte for byte.

## Consequences

- Any agent can be gated in CI on its own captured runs, without a model or a key, with the reason
  for each regression in the pull request.
- The gate is only as sensitive as the runs: with one run per side a flaky task flips the
  verdict. More runs and `--tolerance`, or `--allow` for known flakes, are the levers, and all are
  visible in the report.
- Pass rates are compared as counts with a tolerance, not with a significance test: explainable
  and deterministic, at the cost of treating a one-run drop in 20 runs like one in 2 when the
  tolerance is 0.
- Editing a check set and the agent in the same change means re-judging the baseline: the gate
  refuses to compare runs judged by different sets.
- Verification, compilation, and every committed check set, cassette and report are unchanged.
  `discoverSets` moved from `assay watch` to `src/checks/load.ts` so the library can use it, and
  bench's table code became `alignTable`; both print what they did before.
