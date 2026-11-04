# @swissspidy/assay

## 0.1.0

The first release: compiled outcome verification for web agent tasks.

- Evidence snapshots of a page (accessibility tree, text, URL, network log, storage, backend probes)
  and a declarative check DSL that returns pass, fail or abstain.
- A Playwright fixture and `expectOutcome` that capture evidence during a run and verify it.
- A compiler that turns a task and one correct run into a check set, each check traceable to the
  task text, with stress testing against valid variants and near-miss mutants.
- Escalation of abstained requirements to an agentic verifier that cites its evidence, outcome
  records, a review sheet and check-set locking.
- An evaluation harness over three example apps (30 tasks, 123 labelled runs) and a stability run
  against simulated releases.
