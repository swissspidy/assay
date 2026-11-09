---
'@swissspidy/assay': patch
---

The validator warns that a `text` source "reads free page text" only when it reads the whole document's text: an unscoped `text` source outside an `each` record. A source with a `scope`, or inside an `each` record, reads that node's text, which is derived from accessible names, as the evaluator already read it, so it no longer draws the warning. `assay status` therefore no longer blocks such a requirement at "covered" (the compiled tiny-shop `08-delivery-date` now passes it), `watch` and `review` show no such warning, and compiler coverage and the review sheet count that text as the accessibility tree (semantic) rather than free text.
