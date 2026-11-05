---
'@swissspidy/assay': minor
---

The package installs an `assay` command: `assay compile`, `verify`, `stress`, `validate`, `review` and `capture` run the main workflows without writing code. `assay verify` exits 0 on success, 1 on fail and 2 on abstain, so CI can tell a failed run from an inconclusive one (3 is a usage error, 4 any other error); `--escalate` sends abstained requirements to the agentic verifier and `--record <dir>` writes the outcome record. Output is human-readable by default and JSON with `--json`. Models are chosen with `--provider` (`anthropic` or `ai-sdk`), `--model` and `--cassette`, or `ASSAY_PROVIDER`, `ASSAY_MODEL` and `ASSAY_MODEL_MODE`.

```sh
assay verify checks/add-blue-mug.checks.json snapshot.json --record assay-records
```
