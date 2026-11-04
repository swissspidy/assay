---
'@swissspidy/assay': patch
---

A `text` source with a `scope` now reads the scope's text whitespace-normalized, like a node's text, so a pattern with a plain space also matches non-breaking or doubled spaces. Stress testing re-renders only the part of a value that a check reads after its leading `extract`, deleting `replace` and `trim` steps, so a label the check cuts off ("Estimated delivery:") stays on the page in format variants and mutants.
