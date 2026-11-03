# ADR 0005: Evaluation and stability

- Status: Accepted
- Date: 2026-11-03
- Scope: Milestone 5

## Context

Assay claims that compiled checks verify outcomes about as well as a model, at a tiny fraction of the cost and latency, and that they stay correct as the UI changes. To support that claim we need:

- labelled trajectories, both correct and incorrect;
- the same trajectories judged by the alternatives;
- a repeatable measurement over time.

The trajectories must be reproducible offline and in CI, and no system may see the agent's own success report as evidence.

## Decision

### Dataset: 30 tasks, 3 apps, 123 labelled runs

The dataset uses three small, self-contained apps under `examples/`. All three can serve a deliberately redesigned variant (`UI_VARIANT=redesign`).

| App           | Style                                        | Tasks                                                                        |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Tiny Shop     | client-rendered SPA, JSON API                | newsletter, cart edits, totals, orders, settings                             |
| Tiny Tracker  | server-rendered forms, POST and 303 redirect | create, close and reopen issues, assign, label, comment, rename, filter      |
| Tiny Calendar | SPA, JSON API, locale-dependent dates        | create events, reminders, RSVP, move, delete, location, timezone, week start |

- Every task has a scripted agent (`agent.ts`) and labelled scenarios (`scenarios.ts`).
- Each scenario has a kind: `correct`, `no-op`, `undone`, `wrong-item`, `partial`, `over-completion` or `adversarial`. Adversarial runs make the page claim success without the underlying state changing.
- Each label comes from the scenario definition, not from any verifier.
- `npm run references` records the reference snapshots under `examples/<app>/references/`. Scenarios are replayed live in `tests/scenarios.spec.ts`.

### Systems compared (`npm run eval`)

All systems judge the same captured snapshot. The agent's report is always "I completed the task as requested.", because agents usually report success. Two systems show the report to the model as context; one ignores it.

| System              | What decides                                                                                     | Sees the agent's report   |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------- |
| `checks`            | compiled (or handwritten) check set; abstain counts as "not success"                             | no                        |
| `checks+escalation` | checks; abstained requirements go to the agentic verifier (ADR 0004), snapshot-only              | as labelled context       |
| `llm-judge`         | one model call: task, accessibility outline (200 nodes), visible text (3,000 chars), URL, report | yes, as typical judges do |
| `agentic-verifier`  | ADR 0004 verifier on every hard requirement, snapshot-only                                       | as labelled context       |

Metrics (`src/eval/metrics.ts`):

- Positive means the run really completed the task.
- TPR, TNR and balanced accuracy count an abstain as "not success". The report also shows the abstain rate and the decided-only rates.
- Cost uses list prices per token, with cache reads and writes priced separately.
- Latency is the median and p95 per run.
- A model error counts as an abstain for that run and is recorded with a note.

### Handwritten vs. compiled checks

- The handwritten check sets were written by the same author as the scenarios, so their row is circular and an upper bound. The report says so.
- The real measure is `npm run eval -- --checks compiled`. It uses the check sets from `npm run compile:examples`, each compiled from the task text and one correct run, with all other runs held out.

### Reproducibility

- Model calls go through record/replay cassettes (`eval/cassettes/<system>/<app>/<task>/<scenario>.json`).
- With `ANTHROPIC_API_KEY` set, missing cassettes are recorded. Without one, they are replayed, and systems with no recordings are reported as "not measured" rather than silently skipped.
- Replayed runs carry no latency, so model latency is reported only from recording runs.

### Stability (`npm run stability`, weekly workflow)

The stability run captures every scenario live against two UI variants and judges each run with the same check sets:

- `baseline`, the app as recorded;
- `redesign`: renamed landmarks and headings, relabelled controls ("Cart" becomes "Shopping basket", "Place order" becomes "Buy now"), extra wrappers, and a different date locale (en-US to en-GB).

Each run gets one of three results:

- **correct**: the labelled verdict;
- **abstain**: escalates, which is safe;
- **broken**: the wrong decided verdict, which is the failure we must not have.

Anchor drift is counted separately.

`.github/workflows/stability.yml` runs weekly (Mondays 04:17 UTC) and on demand. It writes the tables to the job summary and keeps the reports as artifacts for 90 days. Over four weeks, those runs make up the stability record.

## Results so far

With the handwritten checks and no model (the model rows wait for an API key):

- Eval: checks reached balanced accuracy 1.000 on 123 runs (TPR 1.000, TNR 1.000), with a median latency of about 0.1 ms per run after capture.
- Stability, baseline: 123/123 correct.
- Stability, redesign: 116/123 correct, 7 abstain, 0 broken, 11 runs with anchor drift. All seven abstains are Tiny Shop checks anchored on the renamed newsletter label, cart region or delivery text. They escalate instead of guessing.

## Consequences

- The comparison is meaningful only once the model rows and the compiled checks are recorded. Until then the report states what was not measured.
- Small first-party apps keep the dataset deterministic and free to run in CI. The cost is less visual and structural variety than real sites.
- The redesign variant is a fixed edit set, so the stability run catches regressions in Assay and in the check sets. It does not stand in for drift in real third-party sites.
