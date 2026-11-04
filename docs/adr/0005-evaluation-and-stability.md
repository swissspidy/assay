# ADR 0005: Evaluation and stability

- Status: Accepted
- Date: 2026-11-03
- Scope: Milestone 5

## Context

Assay claims two things:

- compiled checks verify outcomes about as well as a model does, at a tiny fraction of the cost and latency;
- they stay correct as the application changes.

Supporting the first claim takes labelled trajectories (correct and incorrect) and the same trajectories judged by the alternatives. Supporting the second takes applications that change in realistic ways, including changes that really break the feature under test.

All of it must be reproducible offline and in CI. The agent's own success report is never evidence for Assay's checks.

## Decision

### Dataset: 30 tasks, 3 apps, 123 labelled runs

| App           | Style                                        | Tasks                                                                        |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Tiny Shop     | client-rendered SPA, JSON API                | newsletter, cart edits, totals, orders, settings                             |
| Tiny Tracker  | server-rendered forms, POST and 303 redirect | create, close and reopen issues, assign, label, comment, rename, filter      |
| Tiny Calendar | SPA, JSON API, locale-dependent dates        | create events, reminders, RSVP, move, delete, location, timezone, week start |

- Every task has a scripted agent (`agent.ts`) and labelled scenarios (`scenarios.ts`).
- Each scenario has a kind: `correct`, `no-op`, `undone`, `wrong-item`, `partial`, `over-completion` or `adversarial`. Adversarial runs make the page claim success without the underlying state changing.
- The label comes from the scenario definition, not from any verifier.
- A `correct` run does what was asked and nothing harmful besides. Harmless detours are allowed, such as browsing first or making a mistake and correcting it before the end. Unrequested changes to other data are not, so a run that also reopens an issue or moves an event's time is not labelled correct.
- `npm run references` records the reference snapshots under `examples/<app>/references/`. `tests/scenarios.spec.ts` replays the scenarios live.

### Systems compared (`npm run eval`)

All systems judge the same captured snapshot. The agent's report is always "I completed the task as requested.", because agents usually report success.

| System              | What decides                                                                                                                                                                                         | Sees the agent's report            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `checks`            | the check set; abstain counts as "not success"                                                                                                                                                       | no                                 |
| `checks+escalation` | checks; abstained requirements go to the agentic verifier (ADR 0004), snapshot-only                                                                                                                  | as context, marked as not evidence |
| `llm-judge`         | one judgment (a call, retried at most twice if the reply is not a valid `submit_judgment`; cost covers every call): task, accessibility outline (200 nodes), visible text (3,000 chars), URL, report | yes, as typical LLM judges do      |
| `agentic-verifier`  | the ADR 0004 verifier on every hard requirement, snapshot-only                                                                                                                                       | as context, marked as not evidence |

The LLM judge seeing the report as a plain statement is deliberate. That is what the baseline being compared against does.

Metrics (`src/eval/metrics.ts`):

- Positive means the run really completed the task.
- TPR, TNR and balanced accuracy count an abstain as "not success". The report also shows the abstain rate and the decided-only rates.
- Cost uses list prices per token, with cache reads and writes priced separately, at the model the run was configured with.
- Latency is the median and p95 over runs with a measured time. Replayed model runs have none, and the report says how many runs were timed.
- A model error counts as an abstain for that run and is recorded with a note.

A system is either measured on every run or reported as "not measured" with the reason. It is never scored on a subset. Reasons include no cassette, a stale cassette (the prompt or inputs changed since recording), or an unavailable model.

### Handwritten vs. compiled checks

- The handwritten check sets were written by the same author as the scenarios, so their row is circular and an upper bound. The report says so.
- The real measure is `npm run eval -- --checks compiled`. It uses the check sets from `npm run compile:examples`, each compiled from the task text and one correct run (`compileReference`).
- In compiled mode, those 30 training runs are left out for every system, so every scored run is held out.

### Reproducibility

- Model calls go through record/replay cassettes (`eval/cassettes/<system>/<app>/<task>/<scenario>.json`). The agentic verifier and escalation see the check set's requirements, so with compiled sets their cassettes are kept apart (`eval/cassettes/compiled/<system>/…`). The LLM judge sees only the task and the snapshot, so its recordings serve both modes.
- Existing cassettes are replayed. With `ANTHROPIC_API_KEY` set, missing ones are recorded; `ASSAY_MODEL_MODE=record` re-records all of them, and `ASSAY_MODEL_MODE=replay` (CI) never calls the model.
- Handwritten results go to `eval/results/`, compiled ones to `eval/results/compiled/`.
- The scripts are typechecked with the rest of the code (`tsconfig.json` includes `scripts/`).

### Stability: simulated releases (`npm run stability`, in CI)

Apps that never change cannot show whether checks stay correct, and a weekly re-run of the same apps would only re-test the same code. Instead, each app ships a series of releases (`examples/<app>/releases.json`). `APP_VERSION=N` serves version N, and the releases build on each other:

| Version | Release     | What changes                                                                                                                                              |
| ------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1      | as recorded | nothing                                                                                                                                                   |
| v2      | copy        | renamed labels, headings and buttons ("Cart" becomes "Shopping basket", "Close issue" becomes "Resolve")                                                  |
| v3      | layout      | extra wrappers; look-alike content outside the main region (product prices, other issues, suggested events); British date format in the calendar          |
| v4      | api         | every API record gains `updatedAt` and `etag`                                                                                                             |
| v5      | regression  | a real bug per app: the newsletter choice is echoed but not stored; the feature label is dropped on save; a new event's reminder is echoed but not stored |

A sixth variant, **regression only**, applies just the v5 bug on top of v1. Releases are cumulative, so in v5 a regression can land on a check that already abstains because of an earlier copy change. That would hide whether the checks can detect the bug at all. The regression-only variant measures that directly.

The checks are written for v1, and every scenario runs against every variant.

- The expected verdict is the scenario's label, except where a release breaks a task (`breaks` in `releases.json`). There, the correct runs must now fail.
- Each run gets one of four results:
  - **correct**: the expected verdict for that version;
  - **abstain**: escalates, which is safe;
  - **broken**: a wrong decided verdict, the failure that must not happen;
  - **agent error**: the scripted agent could not finish on that UI, so nothing was judged.
- Anchor drift is counted separately.
- The run fails (exit code 1) if any run is broken.

The run is deterministic and takes under three minutes, so it runs in CI on every change (`ci.yml`, job "Stability"). Each app also answers `GET /__assay/version`, so the runner never silently reuses some other server that happens to be on the port.

### Measuring the model rows live (`model-baselines.yml`)

The apps and the check sets do not change on their own, and the model ID is pinned (`claude-opus-5-5` unless `ASSAY_MODEL` says otherwise), so a schedule would mostly re-measure the same thing. The workflow therefore runs by hand: after changing the model, a prompt or the model adapter, it evaluates the LLM judge and the agentic verifier live, with fresh recordings, and keeps reports and cassettes as artifacts for 90 days so runs can be compared. It needs the `ANTHROPIC_API_KEY` secret and does nothing without it. (An earlier version of this ADR ran it weekly.)

## Results so far

Measured on 2026-11-04 with `claude-opus-5-5` at effort `high`, for the compiler, the LLM judge and the agentic verifier. Latency is per run after capture; model latency is from the live recordings.

- **Compiling:** all 30 tasks compile from one correct run each, and the compiled sets judge every held-out labelled run correctly (`examples/<app>/compiled/SUMMARY.md`). The first live compile missed three: an `anyOf` branch reading a probe field no snapshot had (failed runs abstained), an exact comment text that rejected a correct "Working on it." and row-only checks for a list filter that the seed data already satisfied without the filter. The compiler now refuses `anyOf` branches that no correct run can read, and the discovery prompt covers dictated messages and filter state; the tasks were then re-recorded.
- **Stress (compiled sets):** every near-miss mutant is rejected (216/216, all by fail). 615/617 valid variants are accepted; the two others make one free-text date check in `tiny-shop/08-delivery-date` abstain on doubled spaces (fragile, which escalates, not over-constrained).
- **Eval, compiled checks** (93 held-out runs: 30 correct, 63 incorrect):

| System            | Balanced accuracy | TPR   | TNR   | Cost / run | Latency (median / p95) |
| ----------------- | ----------------- | ----- | ----- | ---------- | ---------------------- |
| checks            | 1.000             | 1.000 | 1.000 | $0         | 0.3 ms / 4.2 ms        |
| checks+escalation | 1.000             | 1.000 | 1.000 | $0         | 0.1 ms / 0.3 ms        |
| llm-judge         | 0.927             | 0.933 | 0.921 | $0.0119    | 4.3 s / 10.0 s         |
| agentic-verifier  | 0.959             | 0.933 | 0.984 | $0.0274    | 8.5 s / 14.5 s         |

- **Eval, handwritten checks** (all 123 runs): checks 1.000; LLM judge 0.944 ($0.0117 per run); agentic verifier 0.984 ($0.0244 per run). The checks row is circular here (see above).
- No compiled check abstained on these runs, so escalation never called the model.
- The LLM judge accepted three adversarial pages that only claim success (a spoofed delivery date, gift wrap and deletion), a wrong rename and the label-only filter, and rejected two correct runs. The agentic verifier, which reads probes and the network log, rejected every adversarial page. It shares two misses with the first compile: it rejected the comment ending in a period and accepted the label-only filter. With the compiled requirements it also rejected a correct express order that added gift wrap.
- **Stability** (handwritten checks, no model):

| Variant         | Correct | Abstain | Broken | Agent error | Regression runs caught |
| --------------- | ------- | ------- | ------ | ----------- | ---------------------- |
| v1              | 123/123 | 0       | 0      | 0           | –                      |
| v2 copy         | 116/123 | 7       | 0      | 0           | –                      |
| v3 layout       | 116/123 | 7       | 0      | 0           | –                      |
| v4 api          | 116/123 | 7       | 0      | 0           | –                      |
| v5 regression   | 118/123 | 5       | 0      | 0           | 6/6                    |
| regression only | 123/123 | 0       | 0      | 0           | 6/6                    |

- The abstains are Tiny Shop checks anchored on renamed text (newsletter label, cart region, delivery text). They escalate instead of guessing.
- The look-alike content in v3 and the extra API fields in v4 changed no verdict.
- Every regression run is caught, in v5 and on its own.
- The regression-only variant first exposed a weak check. The Tiny Shop newsletter checks read the PUT response and the checkbox, and the bug echoes the choice in the response while the page keeps the box checked, so those checks passed. They now also read the stored setting through a `settings` probe.

## Consequences

- The model rows and the compiled checks are recorded, and CI replays them without a key. A change to a prompt, the model or the adapter makes the affected cassettes stale; the report then says "not measured" until they are re-recorded.
- Small first-party apps keep the dataset deterministic and free to run in CI. The cost is less visual and structural variety than real sites. The releases are hand-written, so they test the kinds of change we thought of. Generated changes, for example by asking a model to restyle an app, would widen that.
- API changes in v4 are additive only. Renaming a field that a probe reads changes the probe's contract, much like a breaking API change for any client, and is out of scope here.
