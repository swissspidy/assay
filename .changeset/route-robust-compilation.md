---
'@swissspidy/assay': minor
---

Route-robust compilation (ADR 0011). A check can set `"onMissing": "abstain"` for route evidence (requests, responses, the page URL): when that evidence is missing it abstains with reason `route_missing` instead of failing, evidence that is found but wrong still fails, and inside an `anyOf` the branch of the route the run took decides. The compiler takes references that did the task in different ways (`Reference.note`), refuses route evidence a correct reference lacks unless it is marked so, reports requirements whose only evidence is route evidence (`coverage[].routeOnly`) and refuses them when a probe holds the value they compare. The `items` normalizer gains `flatten`, and the compiler reads "add X" as keeping what the collection held.
