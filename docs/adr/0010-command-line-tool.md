# ADR 0010: The `assay` command-line tool

- Status: Accepted
- Date: 2026-11-05
- Scope: package (`bin`), model selection, exit statuses

## Context

Every workflow (compile, stress-test, review, verify) needed a script. The repository's own scripts
(`scripts/compile-examples.ts`, `stress.ts`, `eval.ts`) show the pattern: read a check set and
snapshots from JSON, call one library function, print a report. Someone trying Assay, or a CI job
gating on a stored snapshot, should not have to write that code.

## Decision

### Commands

The package ships one executable, `assay` (`bin` → `dist/cli/index.js`), with six commands that map
onto existing library calls and add no behaviour of their own:

| Command    | Library call                                      |
| ---------- | ------------------------------------------------- |
| `compile`  | `compileTask` (`/compiler`)                       |
| `verify`   | `verify` (with `verifier`, `recordDir`)           |
| `stress`   | `stressTest`, `formatStressReport` (`/stress`)    |
| `validate` | `validateCheckSet`, `lockState`                   |
| `review`   | `reviewSheet`, `describeAssertion`                |
| `capture`  | `EvidenceRecorder`, `captureSnapshot` in Chromium |

Locking stays in code (`lockCheckSet`): it records a person's confirmation, which a flag on a
command would make too easy to give without reading the review sheet. (Amended by
[ADR 0013](0013-review-workflow-and-signed-locks.md): `assay approve` signs with the reviewer's
private key, which makes the confirmation an explicit act; `reject`, `unlock` and `keygen` complete
the workflow. Signing is optional: without `--key` or `ASSAY_SIGNING_KEY`, `approve` writes an
unsigned lock, and a consumer that needs a signature demands it with `--require-signed`.)

### Exit statuses

| Status | Meaning                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- |
| 0      | success; valid; no stress problems; compiled                                                   |
| 1      | verdict fail; invalid check set (`validate`); stress problems; compile refused                 |
| 2      | verdict abstain                                                                                |
| 3      | usage error                                                                                    |
| 4      | anything else: unreadable or invalid input, missing dependency or key, model or internal error |

- **Abstain is its own status.** A CI job must be able to tell "the agent failed" from "the checks
  could not decide", the distinction the whole design rests on (ADR 0001). Folding abstain into 1
  would make an inconclusive run look like a failure; folding it into 0 would pass it silently.
- **1 is a definite answer about the input; 4 means there is no answer.** An invalid check set is a
  result for `validate` (1) but an error for `verify` and `review` (4), since they cannot run it.
- **`stress` fails on over-constrained, fragile and weak checks and missed mutants.** Advisories
  and checks without a targeted mutant are printed but do not fail: the generator cannot always
  break a check's evidence, and that is not the check's fault (ADR 0003).
- Usage errors are 3, not the conventional 2, because 2 is taken by abstain.

### Arguments and output

- **`node:util` `parseArgs`**, strict, with negatable booleans (`--no-color`, `--no-claims`,
  `--no-storage`). No CLI framework: the package has two runtime dependencies and the commands are
  few. Help text is written by hand per command.
- **Fast startup.** The entry point loads only the parser and help. Each command's module, and the
  library code it needs, is imported when the command runs, and model adapters only when a model is
  used: `assay --help` takes about 40 ms, `assay verify` about 250 ms.
- **People by default, JSON with `--json`.** Human output reuses the library's reports
  (`formatOutcome`, `formatStressReport`, `reviewSheet`), so a report reads the same from code and
  from the terminal. `verify --json` adds `exitCode`, and the checks-only outcome and escalation
  when the verifier ran. `compile` prints the check set to stdout when there is no `--out`, and its
  summary to stderr, so it can be piped.
- **Colour only on a terminal** that supports it (Node's `hasColors`, which honours `NO_COLOR` and
  `FORCE_COLOR`); `--color` / `--no-color` override it. Colour is applied over the plain report.
- **Snapshot files** are a snapshot or a labelled run (`{ label, snapshot }`, the format of
  `examples/*/references`). A directory means every `.json` file in it, sorted. Labels are used:
  `compile` makes a run labelled `fail` a negative reference and `stress` skips it.
- **Errors print one line**, without a stack (`ASSAY_DEBUG=1` adds the stack of an unexpected one).

### Model selection

(Amended by [ADR 0017](0017-config-file-and-bring-your-own-model.md): `model` in
`assay.config.ts` and `--model provider:model` are the general forms; flags win over these
variables, which win over the config. What follows still holds for a bare model id.)

Consistent with the library and the scripts (`scripts/model-from-env.ts`):

- `--provider` / `ASSAY_PROVIDER`: `anthropic` (default) uses `anthropicModel` from `/models`;
  `ai-sdk` uses `aiSdkModel` from `/ai-sdk` with the model id as a string, which the AI SDK resolves
  through its default global provider (the AI Gateway unless the environment configures another).
  A CLI cannot construct provider objects (`anthropic('…')`), so a string id is the general form.
- `--model` / `ASSAY_MODEL`: the model id; `anthropicModel` already reads `ASSAY_MODEL`.
- `--cassette <file>`: replay it if it exists, else record the live run to it (saved when the
  command finishes; a crash keeps `<file>.partial`). `ASSAY_MODEL_MODE=replay` never calls a model
  and so requires `--cassette`; `ASSAY_MODEL_MODE=record` re-records. A replayed compile writes the
  recording's provenance, so it reproduces the recorded check set byte for byte.
- A live Anthropic run without `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) fails before any
  work with a message naming the key and `--cassette`. A missing optional peer (`@anthropic-ai/sdk`,
  `ai`) is reported by name.

### `capture`

`capture <url>` launches headless Chromium through `@playwright/test` (a peer dependency, imported
only by this command; a missing install is reported with the install commands), attaches the
`EvidenceRecorder` before navigating, waits for `--wait-until` and `--wait`, and writes
`captureSnapshot`'s result. It captures a page as loading leaves it. Probes are functions and
baselines need the starting state set up first, so tasks that need them are captured from a
Playwright test (`captureBaseline`, `expectOutcome`); a check set that reads a probe abstains on a
CLI capture. `--executable-path` uses another Chromium build.

## Consequences

- The package has a `bin`; `npx assay` works in any project that installs it. `test:pack` runs
  the installed executable against the example check sets (verdicts 0/1/2, a usage error, validate,
  review, stress, a replayed compile) and, in a project without the optional peers, checks that it
  still verifies and names the missing model dependency.
- `tests/unit/cli.spec.ts` covers parsing and exit statuses in-process; `tests/cli.spec.ts` runs the
  entry point as a process, including a live capture of Tiny Shop. Neither needs a key.
- The exit statuses and the `--json` shapes are an interface: changing them is a breaking change
  (a minor bump while Assay is 0.x).
