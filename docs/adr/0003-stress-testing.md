# ADR 0003: Stress testing compiled checks

- Status: Accepted
- Date: 2026-11-03
- Scope: Milestone 3

## Context

A check that passes on one correct run can still be wrong in two ways:

- **Over-constrained:** it rejects other correct outcomes. This is the main VerifierBench failure.
- **Under-constrained (weak):** it accepts near misses.

Snapshots are plain data and evaluation is pure (ADR 0001), so both can be probed without a browser by editing snapshots.

## Decision

`stressTest(checkSet, correctReferences)` builds two edit families from each correct reference and evaluates the check set on every edit.

### Valid variants (must be accepted)

Generic, task-independent presentation changes:

- `reorder`: list items and table rows reversed (header rows stay first).
- `extra-content`: unrelated content (recommendations, a promotional status message that mentions money).
- `extra-row`: an unrelated extra table row.
- `wrap-main`: main content wrapped in an extra region.
- `spacing`: non-breaking and doubled spaces in visible text.
- `extra-json-fields`: extra fields in JSON bodies and probe results.
- `network-noise`: an analytics beacon and repeated GET requests.
- `url-decoration`: a tracking query parameter on the page URL.

Value-specific formatting is also generated. Every `value` check reading a number, money or date from the page gets the same value re-rendered in other formats of its locale, for example `$21.50` → `US$21.50`, `21.50 USD`, `$21.5`.

A correct reference that the check set rejects is also recorded, as variant `reference`. That is the strongest evidence of over-constraint.

Some generic variants are invalid for some tasks: `extra-row` doesn't apply when the task fixes the number of items. Tasks list those in `skipVariants`. Skipping is visible in the task definition and is a decision for the human reviewer.

### Mutants (must be rejected)

Derived from each check's own evidence, so every mutant is labelled with the check it attacks:

| Check                                                         | Mutants                                                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                                                       | each asserted state flipped; asserted name/value changed; level changed                                                                                  |
| `contains`                                                    | matching items removed; for absence checks, a matching item inserted                                                                                     |
| `value` (page, url, storage)                                  | the read value perturbed: numbers and money ±1 digit or ×10 the leading digit, dates shifted, strings altered, booleans flipped; storage keys also unset |
| `value` with a JSON Schema comparison, `request` body schemas | schema-derived violations: pinned (const/enum) values changed, required array items removed (`contains`), forbidden items inserted (`not.contains`)      |
| `request`                                                     | the request never sent; the request failing with HTTP 500                                                                                                |
| `url`                                                         | the browser ending elsewhere                                                                                                                             |
| `anyOf`                                                       | every alternative broken at once                                                                                                                         |

Two set-level edits:

- **`+claim`:** every rejected mutant is re-run with a success message added to the page. It must still be rejected, which tests that page claims never decide.
- **`claims-only` (advisory):** the page looks exactly like success, but no state-changing request was sent, storage is empty and probes fail. Accepting it is reported, not failed, because some outcomes are legitimately visible only in the UI (a filled cart page).

### Reported results

- **Rates:** valid variants accepted, and mutants rejected, split into rejected by fail vs. by abstain.
- **Over-constrained:** a check that _fails_ on a valid variant or a correct reference.
- **Fragile:** a check that _abstains_ on a valid variant (brittle anchors).
- **Weak:** a check that still _passes_ when its own evidence was broken.
- **Missed:** a definite mutant accepted. A mutant attacking a soft requirement counts as rejected when that requirement stops passing.
- **Untested:** checks the generator found no way to break.

### Integration with the compiler

`verifyCandidate` (ADR 0002) runs the stress test on every submission that otherwise passes. Over-constraint is a submission error, so the agent must fix it. Fragile, weak, missed and advisory findings are warnings in the compile report. The cheapest place to remove an unstated condition is the repair loop, before a human ever sees the check.

## Consequences

- The ten handwritten Tiny Shop check sets accept 81/81 variants and reject 63/63 mutants. The stress run also found one real runtime issue: text read from the accessibility tree wasn't whitespace-normalized before the extract regex ran, so a page rendering non-breaking spaces abstained. That text is now canonicalized, as ADR 0001 §2.3 intends.
- The generators are heuristic. A missing variant type means an over-constraint goes unnoticed, and an inapplicable one means a false flag. Both are bounded by human confirmation (milestone 4/5) and by the `skipVariants` escape hatch.
- Mutation operators exist only for evidence types the DSL supports. A new assertion kind needs a mutation operator, or its checks show up as untested.
