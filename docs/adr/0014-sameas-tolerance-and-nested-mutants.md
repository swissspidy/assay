# ADR 0014: `sameAs` tolerance and nested JSON array mutants

- Status: Accepted
- Date: 2026-11-05
- Scope: check DSL (`assay.checks/v1`), validator, review sheet, stress testing, compiler

## Context

A `sameAs` binding (ADR 0001 §2.7) compares two normalized values exactly. For some values a
correct run does not give two exactly equal values:

- **Rounding.** The confirmation page shows a total to the cent ($21.50) while the backend keeps
  more decimals (21.495), or a duration rounded to the minute.
- **Precision of time.** The page shows a time to the minute ("14:30"), the probe stores it to the
  second (`14:30:27Z`). Both parse to instants, and they differ by 27 seconds.
- **"Now"-ish timestamps.** A server stamps a record moments after the request that created it.

With exact equality such a check fails correct runs. The alternatives were worse: dropping the
binding (losing the tie between page and backend) or comparing with a literal (which only knows the
reference's values). `approx` already exists for literals; a binding had no equivalent.

Separately, the stress generator (ADR 0003) broke JSON arrays only at the top of the value a check
reads (one item removed, changed or added; two records swapping a field). Arrays inside the records
(an order line's options, an issue's labels) were never edited, so a check that ignores them could
not show up as weak, and the order of nested arrays was only varied together with the outer lists
(`json-array-order`), which tasks that ask for an order of records skip.

## Decision

### 1. An explicit, bounded tolerance on the binding

```json
"expect": {
  "sameAs": {
    "source": { "from": "probe", "probe": "latestOrder", "pointer": "/total" },
    "normalize": [{ "op": "currency", "locale": "en-US", "currency": "USD" }],
    "tolerance": { "abs": 0.01, "because": "the page rounds the stored total to the cent" }
  }
}
```

- **Meaning.** The binding holds when |a − b| ≤ max(`abs`, `rel` × |b|), where b is the operand's
  value: `approx` with the other side as its value. `abs` is in the value's unit (money and numbers),
  minutes (date-times) or days (dates); `rel` applies to numbers and money only. Money in different
  currencies is never within tolerance. Without `tolerance`, equality stays exact.
- **Explicit and reviewable.** It sits on the binding, never as a default. `because` is required and
  is shown in the review sheet next to the tolerance and its unit:
  `…, equals backend probe latestOrder at /total, normalized by …, within ±0.01 (because "the page
  rounds the stored total to the cent")`. The sheet also lists it among the check's settings
  (`sameAs tolerance: within ±0.01 (because …)`), and the semantic diff of two versions (ADR 0013)
  reports a tolerance added, removed or changed as a changed field `tolerance`, with the settings
  before and after.
- **Bounded and typed** (validator): `abs` and `rel` are positive; `rel` at most 0.05; date-times at
  most 60 minutes; dates a whole number of days, at most 7. A tolerance on text, booleans or
  collections (`items`) is an error; `items` already compares in any order, so order-insensitive
  (multi)set equality needed nothing new. A value whose type is only known at run time (a raw probe
  field) that is not a number, money, date or date-time abstains with `type_mismatch`.

### 2. Stress testing of tolerances

For a binding with a tolerance, each side in turn (as for exact bindings) gets:

- **Mutants just past the tolerance** (`tolerance:above`, `tolerance:below`): the other side's value
  plus or minus the tolerance, moved to the first multiple beyond it of the finest precision the
  source can show (0.001, 0.01, 0.1, 1; money 0.001, 0.01, 1; seconds then minutes; days), written
  back in the page's own format and kept only if the source reads it back exactly. A check must
  reject them. With a page that shows minutes and a probe that stores 14:30:27, ±1 minute gives
  14:32 and 14:29 on the page and 14:31:01 / 14:28:59 in the probe.
- **Variants inside it** (`tolerance:<check>:±`): a side moved to the edge of the tolerance (or half
  of it), rounded toward the other side so the precision never carries it past. A check must accept
  them. A side that another check also reads is left alone: that check holds the value to its own
  terms.
- The binding's other near misses are those of `approx` with the other side as its value; a
  candidate the binding accepts is no near miss and is not generated. An order-of-magnitude change
  (more than half the value, for numbers and money) is always kept, so an over-wide tolerance shows
  up as weak.

`approx` on literals also gains near misses just past its tolerance at finer precisions
(tolerance + 0.1, 0.01, 0.001; date-times one second past), kept where the source can show them, and
a money candidate is written back as a bare amount where the source holds one (a probe or response
field read through `currency`), so such fields now get mutants at all.

### 3. Teaching the compiler, without invalidating recordings

The compiler's cassettes are keyed on the full request, tool schemas included (ADR 0002), so adding
`tolerance` to the schema the discovery tools send would invalidate every recorded compile. Instead,
tolerance is offered when the evidence calls for it:

- Until then, `submit_checks` and `try_assertion` send the DSL schema without `tolerance` (byte for
  byte the schema they sent before).
- When a submission is refused and a `sameAs` binding in it fails a correct reference by a
  difference a tolerance could cover (numbers or money within 5%, date-times within 60 minutes,
  dates within 7 days), the refusal carries `DISCOVERY_TOLERANCE` (when it applies, its bounds, that
  it needs a reason from the task or the references, and that the smallest one is preferred) and the
  observed differences. From the next turn on, both tools accept `tolerance` (`runAgent` validates
  against a tool's current spec).
- A tolerance that no correct reference needs (both sides equal on every one) is refused.

All 30 example compiles and all 44 real-app compiles replay unchanged with this design, and give
the committed check sets.

### 4. Nested JSON array mutants and the `nested-array-order` variant

- **Mutants.** For a value check whose value (or JSON text read through `json`, e.g. a cart in
  `localStorage`) holds arrays below its top level, each nested array (up to 6, the first items of
  each array, five levels deep) gets: one item removed, one duplicated, one changed (a near miss of a
  nested value), and two nested records swapping one field. As for top-level arrays, an edit is kept
  only when the check's own normalizers and comparison read it as a violation, at most 8 per value,
  interleaved across the nested arrays so that one long array does not use the whole budget.
  Reordering a nested array is not a mutant: a check that rejects it either reads an order the task
  asks for (correct) or is over-constrained, which the variant below finds.
- **Variant `nested-array-order`.** Arrays inside an array's items (each line's options, each
  record's tags) reversed in JSON bodies, probe results before and after the task, and JSON text in
  local and session storage, while the outer lists keep their order. A task that asks for an order
  of its records skips `json-array-order` but still has the order inside each record tested; a task
  where the nested order matters lists `nested-array-order` in `skipVariants`.

## Consequences

- Stress results, before → after (variants accepted, mutants rejected), all accepted and rejected
  before and after:

  | Check sets                | Variants          | Mutants           |
  | ------------------------- | ----------------- | ----------------- |
  | Tiny Shop handwritten     | 223/223           | 157/157           |
  | Tiny Shop compiled        | 231/231           | 227/227 → 239/239 |
  | Tiny Tracker handwritten  | 218/218 → 220/220 | 94/94 → 104/104   |
  | Tiny Tracker compiled     | 218/218 → 220/220 | 72/72 → 82/82     |
  | Tiny Calendar handwritten | 222/222           | 82/82             |
  | Tiny Calendar compiled    | 222/222           | 86/86             |

  The new mutants are nested labels of tracker issues and approx edges of the cart total. On the
  real-app compiled sets (their `reference` runs), 485/485 → 503/503 variants and 364/365 → 424/425
  mutants, with the same known weak checks (w12, s08) and the same missed mutant (s08). No check is
  newly over-constrained, fragile or weak.

- None of the committed check sets compares numbers, money or date-times across sources in a way
  their references disagree on, so none needed a tolerance and nothing was recompiled; the
  evaluation replays are unchanged.
- The tolerance is only as good as its reason: the review sheet shows it, the stress test proves
  that values just past it are rejected, and the validator bounds it, but a reviewer still has to
  agree that the reason holds for the task.
- A compile only learns about tolerances from a refusal, so a task whose single reference happens
  to show equal values ("now"-ish timestamps that agreed) compiles without one; a human can add it,
  with its reason, before locking.
