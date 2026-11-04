---
'@swissspidy/assay': minor
---

Checks can compare the end state with the state before the task. `captureBaseline(page, { probes })` captures probe results, storage and the URL before the agent acts; later snapshots in the same browser context carry it as an optional `baseline` (or pass `baseline` to `captureSnapshot` and `expectOutcome`; `null` leaves it out). A probe or storage source reads it with `"at": "before"`, and a check that reads a missing baseline abstains. The new `items` normalizer treats a JSON array as an unordered collection (filter by JSON Schema, project by pointer), so "keep everything else" is the cart after `sameAs` the cart before minus one item. Snapshots stay `assay.snapshot/v1`; digests of snapshots without a baseline are unchanged. Stress testing mutates the baseline side, JSON arrays (an item removed, changed or added) and adds a "nothing changed" mutant.

A check can set `"onFail": "escalate"` or `"keep"` to override the escalation policy for failures it causes: a failed requirement escalates when every check that failed it allows it. Outcome records show each check's setting and why a requirement was escalated or kept.
