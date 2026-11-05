# ADR 0004: Escalation to an agentic verifier, outcome records, locking

- Status: Accepted
- Date: 2026-11-03
- Scope: Milestone 4 (pipeline steps 5–7)

## Context

Compiled checks abstain when they can't find or read their evidence (ADR 0001). An abstain must not become a silent pass or fail. It goes to an expensive verifier that can explore. Every decision must be auditable afterwards: which checks ran, on what evidence, who decided, and what the agent merely claimed. Checks only run after a human has confirmed them.

## Decision

### Escalation (`verify`)

`verify(checkSet, snapshot, options)` is the one entry point; without `options.verifier` it stops after step 1 and builds the record, and no model runs. `verifyPage` and `expectOutcome` (Playwright) capture the snapshot first and pass the page on for live access.

1. Validate the check set and evaluate it on the snapshot. This step is model-free and takes milliseconds.
2. Select the requirements to escalate. By default these are the hard requirements that abstained. `policy.on` can add `fail`, for example for tasks where checks are known to be brittle, and `includeSoft` adds soft requirements. A single check can override `policy.on` for the failures it causes (see "Per-check escalation" below). A failure is only re-decided if the verifier observes a definite pass or fail; a verifier `unknown` never overrides a decision the checks made.
3. Run the agentic verifier only on those requirements. It gets:
   - the task text and the requirements as their quotes,
   - why each check couldn't decide, as hints, not evidence,
   - read-only tools over the captured snapshot (the compiler's exploration tools),
   - when a page is available, live read-only access: `open_page` (same-origin GET, returning the accessibility tree) and `fetch_json` (same-origin GET),
   - the user's probes, which it can re-run,
   - the agent's report, if given, marked as context only. Embedded texts cannot close their own prompt delimiters.

   Live access runs in a **separate browser context** created from a copy of the session (`storageState`). In that context:
   - non-GET and cross-origin requests are blocked, including those made by page scripts;
   - `fetch_json` does not follow redirects, and a page that redirects off-origin is refused;
   - only http(s) pages get live access.

   So the verifier can't change the application, can't reach other hosts through redirects (SSRF), and its browsing never enters the run's evidence log.

   **Citations.** Every tool result is a numbered observation. `submit_verdict` needs a verdict for every requested requirement, each with a status and the observation numbers it rests on. A `pass` or `fail` without citations, or with citations of observations that don't exist, is rejected and sent back to the model, as are duplicate verdicts. The agent's report is not an observation, so it can never be cited. `unknown` stays `abstain` with reason `verifier_unknown`.

4. Merge. The checks' decisions stand; the verifier's pass or fail fills in the escalated requirements. The verdict is recomputed with the same Kleene rule over the hard requirements, and the returned `Outcome` marks each verifier-decided requirement (`decidedBy: "verifier"`) with its cited evidence, which `formatOutcome` shows. If the verifier fails (model or API error), the checks' outcome stands and the record says `escalation.status: "error"`.
5. Propose (optional). Suppose the checks abstained on hard requirements the verifier then passed, and the final verdict is success. Then the snapshot is a correct run the checks couldn't read. The compiler (ADR 0002, including stress testing per ADR 0003) recompiles **only the checks** from it with the `proposer` model; the confirmed requirements are kept as they are. The proposal gets a unique version (`<version>+proposal.<digest>`) and is recorded as `pending-approval`. It is never used automatically, and a compile failure is recorded as `failed`.

### Per-check escalation (`onFail`)

`policy.on` is one setting for a whole run. Brittleness is a property of one check: a check that reads a date from page text in a format the app may change, next to a probe check whose failure is certain. A check can therefore state what a failure it causes means:

```jsonc
{
  "id": "C2",
  "requirement": "R1",
  "description": "The Order summary shows an estimated delivery date of 2026-11-05.",
  "onFail": "escalate", // or "keep"; unset follows policy.on
  "assert": { "kind": "value", "source": { "from": "node", "...": "..." }, "expect": { "equals": "2026-11-05" } },
}
```

Escalation decides requirements, so the setting is combined per requirement: a failed requirement is escalated when **every check that failed it** allows it, each by its own `onFail` or, if unset, by `policy.on`. One failed check whose failure is certain (`"keep"`, or unset under the default policy) keeps the failure. So `onFail: "escalate"` escalates a failure that only brittle checks caused, even under the default policy, and `onFail: "keep"` keeps a failure that the policy would escalate. Abstains are not affected: an abstain has no decision to keep, so it escalates exactly when `policy.on` includes `abstain` (the default), whatever its checks' `onFail` says. `includeSoft` still decides whether soft requirements escalate.

The setting is on the check rather than the requirement because it describes evidence, not the outcome: the same requirement can have a brittle UI check and a robust probe check, and only the probe check's failure should stand. A requirement-level setting would escalate the probe's certain failures too.

The record shows both sides: each check's `onFail`, and per requirement `escalation`: `"policy"` or `"onFail"` (why it was escalated), or `"kept"` (a check's `"keep"` held a failure back from the policy). It is set when a verifier was given. `reviewSheet` lists the setting under the check, so the reviewer confirms it with the rest of the check.

`expectOutcome` accepts the same options as `verify` (`verifier`, `policy`, `proposer`, `recordDir`, `requireLocked`, …). Escalation happens only after polling has settled, so an abstain waits the full `timeout` first, and `requireLocked` is checked before polling.

### Outcome records (`assay.record/v1`)

One JSON document per verification:

- the task text;
- the check set's ID, version and digest, its lock (by, at) or `null`, and `lockBroken` when a lock is present but no longer matches;
- the snapshot's digest, URL and capture time, plus the path to its content-addressed copy (`snapshots/<digest>.json`, written once);
- the verdict;
- per requirement: quote, status, **who decided** (`checks`, `verifier` or `none`) and the evidence that decided it. For checks, that's the evidence of the checks whose status matches the requirement's. For the verifier, it's the tool outputs it cited, labelled `verifier-cited`; the model's own reasoning is kept in the escalation's verdicts as notes, not as evidence;
- per check: status, abstain reason, message, its `onFail` setting if any; anchor drift; per requirement, when a verifier was given, why it was or was not escalated (`escalation`);
- the escalation, if any: policy, escalated requirements, model, models actually used (fallbacks), status (or error), verdicts, every tool observation, token usage, turns;
- `agentClaims`: the agent's report, labelled `agent-claimed`. It sits next to the evidence for audit and is never an input to any decision;
- the proposal, if any;
- timings: checks, escalation, proposal.

`writeOutcomeRecord(dir, result)` (or `verify`'s `recordDir` option) takes a `verify` result and writes `records/<time>-<id>.json` plus content-addressed copies: `snapshots/<digest>.json`, `checksets/<digest>.json`, `observations/<digest>.txt` (the verifier's full tool outputs, so a decision based on live evidence can be re-checked later) and `proposals/<digest>.checks.json`. It recomputes the snapshot and check-set digests and refuses to write if they don't match the record.

### Human confirmation and locking

- `reviewSheet(checkSet)` renders a Markdown review: each requirement with its quote, and each check with its written description **and** a mechanical description of what it actually tests (`describeAssertion`). A reviewer can then catch a description that doesn't match the check.
- `lockCheckSet(cs, by)` adds `locked: {by, at, digest}`. The digest covers the content together with `by` and `at`, so any later edit, including to the reviewer or the time, breaks the lock (`isLocked`). The digest is unkeyed: it makes accidental and careless edits evident, but anyone can re-lock an edited file. Where a lock must prove who confirmed what, keep a registry of locked digests outside the file, or sign them ([ADR 0013](0013-review-workflow-and-signed-locks.md) adds Ed25519-signed approvals, and locks that name what changed).
- `requireLocked: true` refuses to run an unlocked or edited set. A proposal must be reviewed and locked under a new version before it replaces the current set.

## Consequences

- Escalation is narrow. The verifier sees only what the checks couldn't decide, which bounds cost, and only that is recorded as a verifier decision.
- The record makes the trust boundary explicit: observed evidence vs. agent claims, checks vs. verifier.
- `open_page` and `fetch_json` assume GET endpoints are free of side effects; non-GET requests are blocked, including those made by page scripts. An application whose GET requests change state could still be modified. Deployments with such endpoints should not pass `page` and should rely on probes instead.
- Verifier quality depends on the model. Evaluation (milestone 5) measures it on the same labelled runs as the checks.
