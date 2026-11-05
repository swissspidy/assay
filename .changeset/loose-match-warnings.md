---
'@swissspidy/assay': minor
---

`validateCheckSet` warns about comparisons that accept more than they appear to: an unanchored `regex` with no regex syntax on structured evidence (probe, storage, request or response, URL parts, query parameters), which also matches longer values (`/Berlin/` accepts `Europe/Berlin-Test`), and a JSON Schema property pinned with `const` or `enum` that is not in `required`, so a value without it passes. The compiler refuses both, as well as a check that abstains on a valid stress variant of a correct reference (previously a warning), and its discovery prompt asks for exact comparisons of exact values and for a page identity check (URL path, or a heading or landmark) when a requirement names a page.
