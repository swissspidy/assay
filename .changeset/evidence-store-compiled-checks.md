---
'@swissspidy/assay': minor
---

Deterministic verification is about 35 times faster when a snapshot and check set are verified more than once. Each snapshot is indexed once into an evidence store: the accessibility tree as columns with lookups by role and name, the network log as a table with URLs parsed once, and its digest computed once. Each check set is compiled once into a plan: validated, digested and with every check prepared. Both are cached per object, so a repeated `verify` takes tens of microseconds instead of about 1.3 ms. A first `verify` is now mostly the snapshot digest. Verdicts, messages, evidence and records are unchanged. New `verifyMany(checkSet, snapshots, options)` returns what `verify` returns for each snapshot, in order, running each check across all of them in turn. A snapshot or check set must not be edited after it has been verified; edit a copy.
