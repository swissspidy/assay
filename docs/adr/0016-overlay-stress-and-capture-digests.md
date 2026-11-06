# ADR 0016: Overlay stress and capture-time digests

- Status: Accepted
- Date: 2026-11-06
- Scope: stress testing (`stressTest`, the variant and mutant generators), the evidence store,
  compiled check plans and read-sets, `captureSnapshot`

## Context

ADR 0015 left two costs it named. The stress test copied every variant and mutant
(`structuredClone` of the snapshot, a whole-tree rebuild per edit, `JSON.stringify` of the whole
snapshot to drop no-op edits), gave each copy a store and ran every check on it. And a first
`verify` of a snapshot was mostly its digest (canonical JSON and SHA-256), about 1 ms, which the
record needs.

The constraint is the same as in ADR 0015: every result stays byte-identical. Stress reports,
outcomes and records must match `tests/unit/equivalence/golden.json.gz`, which was written by
the evaluator before ADR 0015 and is not regenerated here.

## Decision

### 1. Variants and mutants are overlays

A variant or mutant is a snapshot built from its reference by replacing a few parts and sharing
the rest **by identity**: the generators already spread the reference (`{ ...s, network }`); they
no longer copy what they do not change.

- **Tree edits share subtrees.** `editById` copies a node only when its children changed (or it
  had an empty `children` list, which the copy drops, as before), so an edit rebuilds the path to
  the edited nodes and shares everything else. Called with the ids it edits (`only`), it visits
  those paths alone, through the tree's `AXIndex`; a tree that is not regular (`regularTree`: an
  empty, holey, inherited or non-list `children` somewhere, or a node with a prototype of its
  own) is walked whole as before, and such a node is still copied (`{ ...node }`) as before. The
  success claim, state, contains, record, frame, value and format edits pass their ids.
- **JSON edits copy the path.** Request bodies and probe results are edited with `withPointer`
  (copy the objects on the pointer's path) instead of cloning the whole network log or value.
  Nested-array edits do the same. The body variants (`extra-json-fields`, `json-array-order`,
  `nested-array-order`) return their input wherever they change nothing.
- **No-op checks compare shared parts for free.** `sameJson(a, b)` is `JSON.stringify(a) ===
  JSON.stringify(b)` without writing either, and equal at once for the same object. A value
  JSON.stringify writes some other way (`toJSON`, which gets its key, or an object that is not
  plain) makes it write both and compare.
  `treeChanged` and the variants' no-op checks use it.

Nodes, entries and bodies are shared between a reference and its overlays, so neither may be
edited in place. The generators never did; edit callbacks get the node and return a new one.

### 2. Checks run only where an overlay changed what they read

`readKeys(readSet)` names the parts of a snapshot a check's result is a function of: `a11y`,
`text`, `page`, `pages`, `network`, `storage`, one probe (`probes:<name>`), and the baseline's
parts (`baseline.storage`, `baseline.probes:<name>`). A read-set that has a part it cannot describe
(an unknown kind or value source) is `opaque`, and its check reads everything. Resolving a target
now always counts as reading the tree, even with no locators.

`changedKeys(base, next)` lists where an overlay differs from its base **by identity**, at the
same granularity: a replaced top-level section, a single replaced probe, or a part of the
baseline. Parts shared by identity are the same evidence, by ADR 0015's rule that snapshots are
not edited once verified.

`PlanRun` runs a plan on one store, computing each check's result on demand, once. Given a base
run (the reference, or for a success claim the mutant it was added to), a check whose read keys
miss every changed key takes the base's result; the others run. `outcome()` equals
`runPlan(plan, store)`. The tree of an overlay is indexed when a check first reads it if it is the
base's or regular (a regular tree always indexes); otherwise eagerly, as `runPlan` does, so a tree
that cannot be indexed still throws where it did.

The stress test judges a mutant by the target check first and stops at the first failing check
of a hard requirement: the verdict is then `fail` whatever the other checks say, which is all the
report records (verdict, rejection, its kind, the target's status). Otherwise, and always for
variants, the full outcome is built. A check set with an opaque check is run in full.

### 3. Capture-time digests

`captureSnapshot` takes the snapshot's digest when it captures it (`sealDigest`), keeps it in a
`WeakMap` beside the snapshot object, and **freezes the snapshot deeply** (every object and array
in it). A record must never carry the digest of evidence other than the evidence verified, and
freezing is what makes that hold without looking at the snapshot again: a frozen object cannot be
thawed, so a frozen snapshot is exactly what was digested, at every depth. An edit in place then
throws (modules run in strict mode) instead of silently leaving a stale digest. The other options
were worse: tracking the identity of top-level fields (the first version of this change) misses
edits inside a section, and checking a fingerprint at `verify` walks the whole snapshot, which is
most of what the digest costs. Freezing is one walk at capture, with no hashing or copying.

The store's `digest` uses the seal (`capturedDigest`) only for the sealed object while it is
frozen; a parsed or copied snapshot (`structuredClone` gives an unfrozen copy that can be edited)
computes its digest as before. A snapshot that holds anything but JSON data (a `Date`, an
accessor) is neither frozen nor sealed. The snapshot's content, and any file written from it, is
unchanged, and `writeOutcomeRecord` still recomputes both digests before it stores a record.
`captureSnapshot(page, { digest: false })` neither seals nor freezes; the CLI's `capture`, which
only writes the file, passes it.

### Not done: scoped capture

Capturing only the union of a check set's read-sets (ADR 0015 §5) is not part of this change.
`readKeys` gives what it needs (which probes, whether the network log, storage or the tree is
read), but leaving sections out changes snapshots and their digests, and an absent section reads
as "not recorded" (abstain) rather than "empty", so it needs its own opt-in format.

## Consequences

- Results are unchanged: the equivalence test passes against the existing golden file (every
  committed snapshot and check set, cold and warm, and the stress test of all 104 committed check
  sets). A new test runs every variant, mutant and claim of a quarter of those sets as an overlay
  and compares the outcome, byte for byte, with a full run on a copy.
- Speed (`node scripts/bench.ts --filter stress,verify`, this change against `--lib` of the commit
  before it, same machine):

  | Workload                                    | Before  | After    |
  | ------------------------------------------- | ------- | -------- |
  | `stress`, 74 check sets, median pass        | 646 ms  | 279 ms   |
  | `verify`, 354 pairs, parsed (cold)          | 1.16 ms | 1.06 ms  |
  | `verify`, real-app pairs, captured snapshot | ~1.5 ms | ~0.27 ms |

  The last row is not a bench workload (the bench parses snapshots from files): it seals each
  parsed snapshot first, as `captureSnapshot` does, outside the timing. In stress, read keys
  alone skip about 60% of the check runs (the hard-failure stop skips more), few trees are indexed for mutants whose target reads other
  evidence, and copying is gone from the profile. What remains is mostly the generators' own
  work (choosing near misses, normalizing and comparing candidate values), indexing edited trees,
  and running the checks an overlay touches. An incremental tree index (copying the base's rows
  for shared subtrees) would cut the second; it was not built here.

- Snapshots, their sections, nodes and bodies are shared between a reference and its variants
  and mutants. Code that receives a `Variant` or `Mutant` must not edit its snapshot in place.
- A snapshot returned by `captureSnapshot` is frozen. Code that edited a captured snapshot in
  place now gets a `TypeError`: edit a copy (`structuredClone`), or capture with
  `digest: false`. No code in this repository did.
