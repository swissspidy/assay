---
'@swissspidy/assay': minor
---

A `sameAs` binding can take an explicit, bounded tolerance with its reason, `"tolerance": { "abs": 0.01, "because": "…" }` (minutes for date-times, days for dates, `rel` up to 5% for numbers and money), for values that correct runs give slightly differently in two sources. The validator bounds it, the review sheet shows it, and the stress test rejects values just past it and accepts values inside it. The compiler offers it only once a correct reference shows a binding that needs one. Stress testing also breaks arrays nested inside JSON values (an item removed, duplicated or changed, two nested records swapping a field) and adds the `nested-array-order` variant.
