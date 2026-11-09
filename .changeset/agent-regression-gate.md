---
'@swissspidy/assay': minor
---

`assay gate` is a regression gate for agent changes: it verifies the runs captured before a change (`--baseline`) and after it (`--candidate`) with the same check sets, deterministic checks only, and classifies every task and requirement as regressed, improved, unchanged, new or missing. A regression is a pass count that drops by more than `--tolerance` runs (default 0, the baseline's rate scaled to the candidate's runs); abstain counts as not passing. It exits 1 on any regression or missing task, `--allow <task>[:<requirement>]` reports known-flaky work without failing on it, and both sides must be judged by the same check set. Output: a compact table, `--json` (`assay.gate/v1`) and `--markdown <file>`, a pull request comment that shows each regression's failing check, what it expected and found, and the run. `gate()` in the package root does the same for an optimizer's acceptance function; the config takes `gate: { baseline, candidate, checks, allow, tolerance, minRuns }`.

```sh
assay gate --baseline runs/main --candidate runs/pr checks/ --markdown gate.md
```
