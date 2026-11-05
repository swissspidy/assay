# ADR 0008: Per-record checks (`each`) and paired item fields (`items` `pick`)

- Status: Accepted
- Date: 2026-11-05
- Scope: check DSL (`assay.checks/v1`), validator, stress testing, compiler

## Context

Review of the compiled check sets (PR #18) found three facts the DSL could not state:

1. **A definition with its term.** Tiny Calendar 01 asks that "the event page shows the date
   November 5, 2026". The page shows a description list (`When` / `Thursday, November 5, 2026,
   12:30 PM`, `Duration` / `1 hour`, …). The compiled check matched any `definition` whose text
   looked like that date, so the date shown under another term, or in another field of the page,
   satisfied it. In the accessibility tree a `dt` and its `dd` are siblings, so `within` (an
   ancestor) cannot tie them together.
2. **A cell of the row named X.** Tiny Tracker 10 could assert that some row is named X and that
   some cell reads "Open", but not that the row named X has the "Open" cell. A row with another
   issue's status satisfied both halves.
3. **Several fields of a collection item.** `items` projects one field (`pointer`) or keeps
   whole records. When order lines carry fields the cart lacks (`lineTotal`), whole records never
   compare equal, and one check per field sorts each field on its own, so 1×A + 2×B matched
   2×A + 1×B (ADR 0001 §2.6).

The fix had to be additive: existing check sets keep validating and give identical verdicts.

## Decision

### 1. `each`: an assertion inside every record a locator matches

```jsonc
{
  "kind": "each",
  "scope": { "role": "main" }, // optional anchor, as for contains
  "witness": { "role": "term", "text": "When" }, // optional anchor: the label exists whatever the outcome
  "match": { "role": "term", "text": "When" }, // the records
  "count": { "eq": 1 }, // how many records match; default { "gte": 1 }
  "assert": {
    "kind": "value",
    "source": { "from": "node", "target": { "role": "definition" }, "field": "text" },
    "normalize": [
      { "op": "replace", "regex": ",? \\d{1,2}:\\d{2}( ?[AP]M)?$", "flags": "i", "with": "" },
      { "op": "date", "locale": "en-US" },
    ],
    "expect": { "equals": "2026-11-05" },
  },
}
```

- **Records.** Every node matching `match` inside the scope is a record: the node and its
  subtree (a row, a list item, an article, a group). A matched `term` is the term together with the
  `definition` siblings that follow it, which is how a `dt` and its `dd`s appear in the
  accessibility tree. Consecutive terms (`dt dt dd`) share the definitions after the last of them.
- **Resolution inside a record.** Every locator in `assert` (targets, scopes, `contains` matches,
  witnesses, the node and text sources of a `value` and of its `sameAs` operand) resolves among the
  record's descendants. A `contains` without a scope searches the record, and a `text` source
  without a scope reads the record's text (canonicalized, ADR 0001 §2.3). `within` and `landmark`
  still look at all ancestors, inside the record or not. An `each` nests: an order's list item, and
  in it the line of one product.
- **Anchors and outcome.** The scope and witness are anchors: missing or ambiguous, the check
  abstains (ADR 0001 §2.1). The number of records is outcome evidence: outside `count`, the check
  fails, as `contains` does. Inside, a missing anchor abstains with a message naming the record.
- **Labels are anchors.** A record found by a label the page shows whatever the outcome (the
  term "When") should name that label as its `witness` too: renamed copy then abstains instead of
  failing the count. A record found by outcome data (the row of the issue the task created) needs
  none.
- **Every record.** The nested assertion must hold in every record, combined with strong Kleene
  conjunction: one record failing fails the check, one abstaining while the others pass abstains.
  "The row named X has cell Y" is an `each` whose `match` selects that row; "every listed issue
  is open" is an `each` over all rows. The message lists the records that decided.
- **Only the record may be read.** Inside `each`, a `url` or `request` assertion, or a `value`
  whose source is not a node or text, reads the same thing for every record; the validator
  rejects it. The other side of a `sameAs` may read any source (the row's order number equals the
  `latestOrder` probe's `/id`).
- **Trust.** Records are found in the accessibility tree, so an `each` is as hard to fake as its
  nested assertion, at most `semantic` (ADR 0002 coverage).

### 2. `items` `pick`

`{ "op": "items", "pick": ["/sku", "/qty"] }` maps each item to an object of the values at those
pointers, keyed by pointer (`{"/sku": "MUG-RED", "/qty": 1}`), then sorts as before. The fields of
one item stay together, so `sameAs` compares records on exactly the fields both sides have. A
missing field cannot be read (`normalize_failed`, as for `pointer`). `pointer` and `pick` together
are rejected. Keys are the pointers, not the last segments, so `/a/id` and `/b/id` cannot collide
and the evidence shows where each value came from.

### 3. Validator

- The field-by-field rule (ADR 0001 §2.6) now compares projections: two or more comparisons of
  the same two collections in one requirement are loose unless one of them keeps every field the
  others compare together (whole items, or a `pick` of all of them).
- **A definition found by its own content** is a new loose match: a `state`, `contains`
  (presence), `value` or `each` that locates a `definition` (directly or through `within`) outside
  an `each` whose records are terms. A definition means something only with its term; selecting it
  by its own text accepts the value under any term. An absence check across all definitions is a
  page-wide fact and is not flagged. Like the other loose matches, `validateCheckSet` reports it as
  a warning and the compiler refuses it (ADR 0002).
- `each` without a scope gets the same warning as `contains` without one, and a `count` that
  allows zero records without a witness gets the vacuous-absence warning.

The task also asked whether to flag a requirement that states a per-row fact but is checked
without a record. That needs reading the requirement's text, and a cell matched across a whole
table is often right ("no Closed issue is listed"), so no rule detects it reliably. Only the
definition case is structural: a `dd` has no meaning without its `dt`.

### 4. Stress testing (ADR 0003)

- **Mutants of an `each`:** the number of records (as for `contains`: all removed, one fewer,
  another item in place of the first, an extra one past an upper bound); the nested assertion's
  mutants inside the first record; and two record mutants that keep every value on the page but
  take it out of its record:
  - **`record:swap`:** the parts of the record the nested assertion reads (the cells of a row, the
    definitions of a term) are exchanged with those of another record of the same kind, chosen
    among the records whose own content does not satisfy the assertion. The When date moves under
    Duration, and "1 hour" under When.
  - **`record:moved`:** those parts are blanked in the record and shown in a paragraph right after
    it (after the row, or after the term's last definition).

  Parts that identify the record (its term, a row's title cell) are never moved, and a mutant whose
  record no longer matches `match` is dropped. A row named by its cells gets its new text as its
  name. A check that reads the value anywhere on the page accepts both mutants; a record check
  rejects them.

- **Pairing swap:** for a JSON array of records, two records exchange one field. Every field taken
  on its own still holds the same values; only whole-record and `pick` comparisons see it. As for
  the other array edits, it is kept only when the check's own normalizers and comparison read it
  as a violation.
- **Valid variant `reorder-terms`:** term groups (a term with its definitions) in reverse order.
  Formatting variants also re-render values that an `each` reads inside its records.

### 5. Compiler

The discovery prompt documents `each` and asks for it whenever a value belongs to one row, list
item or field; the baseline section documents `pick` for collections whose items carry different
fields. The compiler refuses the new loose match like the others.

## Alternatives considered

- **A `has` filter on locators** (as Playwright's): `{role: "row", name: …, has: {role: "cell",
  name: "Open"}}`. It expresses "the row named X has cell Y", but only as text matching: a value in
  a row could not be normalized and compared (a quantity, a price with a tolerance, a date in any
  format), and it cannot reach a `dd`, which is not inside its `dt`.
- **A `term` property on locators** (`{role: "definition", term: "When"}`). It fixes the
  description-list case only. `each` covers it and rows, items and nested records with one rule.
- **A `scope` field on every assertion and value source.** It re-roots one read at a time, so
  several reads (a row's status and its label) could resolve in different rows, and every kind
  would grow a field. One `each` around them binds all of them to the same record.
- **"Some record" semantics** (pass when any record satisfies the assertion). "The row named X
  has Y" is `each` with a `match` that names X; a check that any row has Y is already a `contains`.
  Every-record semantics keep `each` from passing on one good record among bad ones.
- **Column binding** (a cell under the column header "Status"). The accessibility tree gives no
  column indices, and spanning cells make a position-based guess wrong. Matching a cell by its
  content inside the row covers the cases seen so far.
- **A tuple for `pick`** (`["MUG-RED", 1]`). An object keyed by pointer shows in the evidence
  which value is which field.

## Compatibility

`each` and `pick` are additive to `assay.checks/v1`. An assertion outside `each` resolves against
the document exactly as before, so existing check sets give identical verdicts. The new loose-match
warning can appear on an existing set that reads a definition by its content (one compiled set did,
and was recompiled). `resolveTarget` takes an optional scope.

## Consequences

- The compiled Tiny Calendar 01 now reads the date from the definition of "When"; the handwritten
  Tiny Calendar 01 and Tiny Tracker 10 sets were tightened the same way (the row of issue #1 shows
  Open and bug).
- Stress counts grow with the new mutants and the new variant; see ADR 0005 for the dated numbers.
- A record is found by content the page shows (a row's name, a term's text). Without a witness,
  renamed copy makes the record count zero, which fails rather than abstains, as for `contains`;
  the prompt asks for the label as witness.
