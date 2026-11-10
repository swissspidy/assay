---
'@swissspidy/assay': minor
---

The mining-first compiler (`discovery: "mine-first"` / `"mine-only"`) covers more requirements, without settling any on weaker evidence than before. "Add X" is mined as X being there plus the collection without X equal to the collection before the task without X (`at: "before"` and the `items` normalizer, ADR 0011), and settles only with a baseline that lacks X. "Only X" and "every X is Y" are mined as per-record checks over a probe's or storage key's records (every record is X, and one is; every record that is X is Y, and one is both), and as an `each` over a table column, which settles only when it rejects an incorrect reference. A small, documented table of field-name synonyms ("quantity" for a `qty` field, "appointment" for an `events` probe, …) widens which field names account for a quote word, never which values. The default `discovery: "model"` is unchanged.
