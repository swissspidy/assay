---
'@swissspidy/assay': minor
---

Scoped capture (ADR 0025). `captureScopedSnapshot(page, checkSet)` (and `assay capture --scope <checks>`) records only what a check set reads: the sections its checks read, the requests some check could match, and the storage keys and probes read, skipping the capture of everything else. `scopeSnapshot(snapshot, checkSet)` derives one from a full snapshot. A scoped snapshot has its own schema, `assay.snapshot.scoped/v1`, and names the check set's content digest: `verify`, `verifyMany` and `assay verify` with that check set give the outcome the full snapshot gives (citing the scoped snapshot's own digest), while another check set, escalation, `stressTest`, `compileTask`, `evaluate` and `loadSnapshot` (without `{ scoped: true }`) refuse it with a clear error. On the 228 real-app runs, scoped snapshots are 97% smaller.
