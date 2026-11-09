---
'@swissspidy/assay': minor
---

`assay status`: one row per task with its readiness ladder (valid, covered, reviewed and locked, stress-clean, passes its references, passes its recent runs), where each stage is evaluated only once the one before it passed, and the first one that fails names its blocker ("changed since lock: check C2 changed", "C1 fails on variant reference/extra-json-fields", "wrong-mug: SUCCESS, expected fail"). `--stage <name>` exits 1 unless every task got through that stage, so CI can require, for example, that every task is locked (`assay status --stage locked`); `--json` prints a stable `assay.status/v1` shape; `--no-stress` leaves out the stress stage. The same in code: `status(options)` and `formatStatus(result)` from `@swissspidy/assay`, and `status: { stages, recentRuns: { last, minPassRate } }` in `assay.config.ts`.
