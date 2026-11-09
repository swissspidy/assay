# ADR 0028: Scoped text in run outcomes and check descriptions

- Status: Accepted
- Date: 2026-11-09
- Scope: the evaluator's `text` reader (`src/plan/assertions.ts`), `describeAssertion` and the
  check builder's default descriptions (`src/verifier/lock.ts`, `src/checks/builder.ts`), the
  equivalence golden (`tests/unit/equivalence/`)
- Builds on: [ADR 0001](0001-evidence-snapshot-and-check-dsl.md) §2.6, [ADR 0013](0013-review-workflow-and-signed-locks.md),
  [ADR 0015](0015-evidence-store-and-compiled-checks.md), [ADR 0019](0019-typed-checks-matcher-and-watch.md)

## Context

A `from: "text"` source with a `scope`, or inside an `each` record, reads the canonical text of
an accessibility node, which comes from accessible names. Only an unscoped source outside a record
reads the document's free text (`snapshot.text`). `textSourceChannel(src, inRecord)` states this
rule. The validator, compiler coverage and trust, the review sheet's evidence list and
`assay status` already use it. Two places still treated every text source as free text, and both
were left alone on purpose because changing them has compatibility costs:

1. **Run outcomes.** When the reader read a value, its evidence said channel `text`, trust
   `freetext`, even for scoped or record text. That evidence goes into check results, outcomes and
   records. The equivalence test compares outcomes and records byte for byte with
   `golden.json.gz`, and that file is never regenerated (ADR 0015, ADR 0016).
2. **Check descriptions.** `describeAssertion` called every text source "(free text, spoofable)".
   It writes the default description of every check built with the TypeScript builder (ADR 0019),
   and a lock covers the exact text, descriptions included (ADR 0013).

## Decision

### 1. Run outcomes record the channel the value was read from

The reader's evidence for a value it read now uses the channel it read from. That is `a11y` with
trust `semantic` for a scope's or a record's text, and `text` with `freetext` for the whole
document. The comment that kept `text` is gone.

**Why the existing fields change (option a), and no derived field is added (option b).** Option b
would apply if outcome evidence deliberately recorded the raw snapshot channel, with trust derived
from it somewhere else. It does not. A scoped or record read never looks at `snapshot.text`: it
reads `index.canonicalText(node)`, which is accessibility-tree data. The same reader's abstain
paths (pattern not found, group not matched) already recorded `a11y` for these sources. The old
`text` was the one place that called a value free page text when it was not, and a separate field
would have kept that wrong statement in `channel` and `trust`. Records describe their evidence as
"what decided it". An auditor reading `trust: "freetext"` on a value taken from a named region
would draw the wrong conclusion.

**What changes in an outcome.** In each evidence entry of a successful scoped or record text read
(pass, fail, or an abstain from a normalizer, which carries the read value), `channel` changes
from `"text"` to `"a11y"` and `trust` changes from `"freetext"` to `"semantic"`. The value,
`locator` (`text of …`, with ` (raw …)` after a normalizer), `origin`, drift, status, reason,
message and verdict stay the same. A whole-document read keeps `document text`, `text` and
`freetext`.

**Who reads evidence trust.** `formatOutcome` (`report.ts`) and the `toHaveCompleted` failure
message print it. Records copy check evidence into `requirements[].evidence`, and the gate copies
`channel` into its `found` lists. Nothing that decides a result reads it:

- Escalation (`selectRequirement`) uses requirement status, kind, the policy and the checks'
  `onFail`.
- Verdict aggregation uses statuses.
- Stress testing uses check statuses.
- The compiler's `try_assertion` and `submit_checks` tools show the model status, reason and
  message only. Cassettes and compile replays therefore cannot change.

This ADR changes no verdict, requirement status or escalation decision.

**The golden file is migrated, not regenerated.** `tests/unit/equivalence/migrate-0028.ts` takes a
checkout of the evaluator before this change (c5d6c30) and processes every one of the 5,869
verify cases:

1. It runs that evaluator and requires the result to equal the golden one: the stored JSON for the
   480 own cases, the digest for the rest. The old result is therefore known exactly, including
   for cases the golden file keeps only a digest of.
2. It applies exactly one transformation. Each evidence entry with channel `text`, trust
   `freetext` and a locator starting with `text of ` becomes `a11y`, `semantic`.
3. It requires the transformed result to equal, byte for byte, what the new evaluator returns.

The script writes nothing if any case fails. It also requires every stress digest to be unchanged.
Result: **28 cases change (10 stored as JSON, 18 as digests), in 42 evidence entries, all for the
tiny-shop compiled `07-express-order` and `08-delivery-date` sets (on 14 of the 40 tiny-shop runs each: those where the scoped or record
text was read). All 104 stress
reports, and the `commit` the golden file names, are unchanged.** Running the script again from
the pre-0028 golden file reproduces the committed one byte for byte. `generate.ts` now says that
an intended change moves the golden file this way.

The committed stress reports, compile replays (every `checks.json`, report and `SUMMARY.md`), the
evaluation results (except timings), `examples/gate/REPORT.md` and `examples/status/STATUS.txt`
are unchanged. None of them prints evidence trust.

### 2. Descriptions say "accessibility-tree text"

`describeAssertion` now describes a text source by what it reads:

| Source                     | Before                                                          | After                                                             |
| -------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| unscoped, outside a record | `page text matching /p/ (free text, spoofable)`                 | unchanged                                                         |
| with a `scope`             | `page text matching /p/ inside <target> (free text, spoofable)` | `the text matching /p/ inside <target> (accessibility-tree text)` |
| unscoped, inside an `each` | `the record text matching /p/ (free text, spoofable)`           | `the record text matching /p/ (accessibility-tree text)`          |

The review sheet's "tests" line, `assay review`, the gate's `expects` and the matcher's `expected:`
line use the new wording. None of these is digested.

**Committed sets and locks.** No committed check set, lock, cassette or report contains a
generated text-source description: "spoofable" appears in no committed data file, plain or
gzipped, and only in docs, source and tests. Mining never writes a text source, so mined
descriptions (`Mined: …`) do not change. JSON check sets store descriptions literally, so their
locks cannot change. `assay approve`, `reject` and `unlock` write a module's set as JSON (ADR
0019), so that path is unaffected as well.

**Builder sets that carry a decision.** One case is affected: a TypeScript module that passes
`locked` (or `rejected`) to `checks()` and leaves a scoped or record text check on its default
description. `assay checks print --ts` of a locked JSON set produces exactly this, because it
omits descriptions that equal the default. The lock digest was computed over the old wording, so
with only the new wording such a set would read "changed since lock: check C2 changed" when no
one changed anything. Three options were considered:

- Accept the change and flag it in a changeset. Every affected set would need a fresh approval
  for a change nobody made, and `status` and `verify --require-locked` would block until then.
  That is surprising, and a security-relevant review step would turn into routine re-approval.
- Keep the old wording as the builder default everywhere. New sets would then be described as
  free text when they are not, which is the inconsistency this ADR removes.
- **Chosen:** keep the old wording only where a decision was made on it. If the spec carries
  `locked` and the set built with the new wording does not verify, `checks()` builds it again
  with the pre-0028 wording (`describeAssertionAs(a, 'pre-0028')`). It uses that version if, and
  only if, the lock then verifies. The same applies to `rejected`, compared by its content digest.
  Everything else gets the new wording.

The fallback cannot hide a real change. It touches only default descriptions, never an explicit
one or any other field, and it is used only when the result is exactly the content the lock's
digest covers. A set changed after approval stays broken, and it is shown in the current wording.
The pre-0028 wording is frozen in a test. `printCheckSet` writes the old wording literally,
because it no longer equals the default, so a printed set loads back deep-equal and still locked.
To move a set to the new wording, approve it again.

## Consequences

- Outcomes, records, `formatOutcome` and matcher messages now say `a11y/semantic` for scoped and
  record text, in line with the validator, coverage, the review sheet and `status`. A consumer
  that filtered on `channel === "text"` to find spoofable evidence no longer gets these false
  positives. A changeset announces the change.
- The equivalence golden changed in exactly the fields above, through a committed, re-runnable,
  self-checking migration instead of a regeneration.
- Builder sets locked on the old wording keep verifying, and keep showing the description their
  reviewer approved. Unlocked and newly approved sets get the accurate wording.
- `describeAssertionAs` and `DescriptionWording` are internal (`src/verifier/lock.ts`) and not
  exported from the package root.
- Tests: `tests/unit/text-evidence-0028.spec.ts` covers evidence for pass, fail and
  normalize-abstain on each kind of source, the 08-delivery-date verdicts and R4 evidence, both
  wordings, and locks and rejections made on each wording, including a real change after
  approval and a print round trip.
