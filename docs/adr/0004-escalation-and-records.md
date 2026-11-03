# ADR 0004: Escalation to an agentic verifier, outcome records, locking

- Status: Accepted
- Date: 2026-11-03
- Scope: Milestone 4 (pipeline steps 5–7)

## Context

Compiled checks abstain when they can't find or read their evidence (ADR 0001). An abstain must not become a silent pass or fail. It goes to an expensive verifier that can explore. Every decision must be auditable afterwards: which checks ran, on what evidence, who decided, and what the agent merely claimed. Checks only run after a human has confirmed them.

## Decision

### Escalation (`verifyWithEscalation`)

1. Evaluate the check set on the snapshot. This step is model-free and takes milliseconds.
2. Select the requirements to escalate. By default these are the hard requirements that abstained. `policy.on` can add `fail`, for example for tasks where checks are known to be brittle, and `includeSoft` adds soft requirements. Requirements the checks decided are never re-decided.
3. Run the agentic verifier only on those requirements. It gets:
   - the task text and the requirements as their quotes,
   - why each check couldn't decide, as hints, not evidence,
   - read-only tools over the captured snapshot (the compiler's exploration tools),
   - when a page is available, live read-only access: `open_page` (same-origin GET in a new tab, returning its accessibility tree) and `fetch_json` (same-origin GET with the session's cookies). Cross-origin URLs are refused,
   - the user's probes, which it can re-run,
   - the agent's report, if given, marked as context only.

   `submit_verdict` must give a verdict for every requested requirement. A `pass` or `fail` without cited evidence is rejected and sent back to the model. `unknown` stays `abstain`.

4. Merge. The checks' decisions stand; the verifier fills in only the escalated requirements. The verdict is recomputed with the same Kleene rule over the hard requirements.
5. Propose (optional). Suppose the checks abstained on requirements the verifier then passed, and the final verdict is success. Then the snapshot is a correct run the checks couldn't read. The compiler (ADR 0002, including stress testing per ADR 0003) recompiles from it with the `proposer` model. The proposal is recorded as `pending-approval` and is never used automatically.

`expectOutcome` accepts `escalate` (escalation happens after polling has settled, with live read-only page access) and `recordDir`.

### Outcome records (`assay.record/v1`)

One JSON document per verification:

- the task text;
- the check set's ID, version and digest, and lock (by, at), or `null` if unlocked;
- the snapshot's digest, URL and capture time, plus the path to its content-addressed copy (`snapshots/<digest>.json`, written once);
- the verdict;
- per requirement: quote, status, **who decided** (`checks`, `verifier` or `none`) and **observed evidence only**. That's check evidence for check decisions, and the verifier's cited observations for verifier decisions;
- per check: status, abstain reason, message; anchor drift;
- the escalation, if any: policy, escalated requirements, model, models actually used (fallbacks), status, verdicts, every tool observation, token usage, turns;
- `agentClaims`: the agent's report, labelled `agent-claimed`. It sits next to the evidence for audit and is never an input to any decision;
- the proposal, if any;
- timings: checks, escalation, proposal.

`writeOutcomeRecord(dir, record, snapshot, proposal?)` writes `records/<time>-<id>.json`, `snapshots/<digest>.json` and `proposals/<digest>.checks.json`.

### Human confirmation and locking

- `reviewSheet(checkSet)` renders a Markdown review: each requirement with its quote, and each check with its written description **and** a mechanical description of what it actually tests (`describeAssertion`). A reviewer can then catch a description that doesn't match the check.
- `lockCheckSet(cs, by)` adds `locked: {by, at, digest}`. The digest covers everything else in the set, so any later edit breaks the lock (`isLocked`).
- `requireLocked: true` refuses to run an unlocked or edited set. A proposal must be reviewed and locked under a new version before it replaces the current set.

## Consequences

- Escalation is narrow. The verifier sees only what the checks couldn't decide, which bounds cost, and only that is recorded as a verifier decision.
- The record makes the trust boundary explicit: observed evidence vs. agent claims, checks vs. verifier.
- `open_page` assumes GET pages are free of side effects. An application whose GET requests change state could be modified by the verifier. Deployments with such endpoints should not pass `page` and should rely on probes instead.
- Verifier quality depends on the model. Evaluation (milestone 5) measures it on the same labelled runs as the checks.
