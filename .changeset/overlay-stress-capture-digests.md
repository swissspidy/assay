---
'@swissspidy/assay': minor
---

The stress test is about twice as fast, with the same reports. Variants and mutants now share every part of their reference snapshot they do not change instead of copying it, and only the checks that read a changed part run again; a mutant is judged by its target check first and stops at the first failing hard check. `captureSnapshot` now takes the snapshot's digest at capture time and keeps it beside the snapshot object, so a first `verify` of a snapshot just captured takes about 0.3 ms instead of 1.5 ms; a parsed or copied snapshot, or one whose sections were replaced, computes its digest as before, and snapshots and records are unchanged. Pass `digest: false` to skip it. The snapshots of the variants and mutants that `generateVariants` and `generateMutants` return share objects with the reference; do not edit them in place.
