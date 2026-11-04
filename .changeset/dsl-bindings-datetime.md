---
'@swissspidy/assay': minor
---

Two additions to the check DSL. A `sameAs` comparison binds a value to a value read from a second source, each normalized by its own pipeline: for example, the order number on the confirmation page must equal the `latestOrder` probe's `/id`. Either side unreadable abstains; both read and different fails. A `datetime` normalizer parses date-times to an instant in UTC (the value's own offset, or the wall clock in `timezone`; ambiguous values abstain), and `approx` on datetimes takes a tolerance in minutes. Stress testing perturbs either side of a binding, shifts datetimes past their tolerance and re-renders them in other localized formats.
