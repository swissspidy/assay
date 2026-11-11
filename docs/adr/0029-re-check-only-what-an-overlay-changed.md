# ADR 0029: Re-checking only what an overlay changed

- Status: Accepted
- Date: 2026-11-11
- Scope: overlay runs (`PlanRun`, `src/plan/plan.ts`), change descriptions (`src/plan/delta.ts`),
  `stressTest` and its variants (`src/stress/stress.ts`, `src/stress/variants.ts`), regularity of
  edited trees (`src/store/ax.ts`)
- Builds on: [ADR 0015](0015-evidence-store-and-compiled-checks.md) (read-sets),
  [ADR 0016](0016-overlay-stress-and-capture-digests.md) (overlays and read keys),
  [ADR 0023](0023-incremental-tree-index.md) (derived tables, and the profile that named this step)

## Context

ADR 0023 found that tree indexing was about a quarter of stress time and named the next step:
re-check only what a variant or mutant changed. A check whose reads of a snapshot an edit does not
reach gives the result it gave on the reference, so it need not run again. The goal set for this
work was to approach a 10× faster stress test, without changing any report.

ADR 0016 already does this at the granularity of read keys: a check that reads none of the
sections an overlay replaced (the tree, the page text, the network log, one probe, the baseline's
storage) takes its base's result. What it cannot tell is whether a check that reads a replaced
section reads the part of it that changed: every check of the tree runs again on every tree edit.

### What was left to skip

Counted over the bench's `stress` workload (74 check sets, 177 references, one pass), before this
change:

| Overlays                          | Check results used | Evaluated | Same result as the base |
| --------------------------------- | -----------------: | --------: | ----------------------: |
| 1,256 variants                    |              2,818 |       645 |                     189 |
| 984 mutants (stop at a hard fail) |              1,145 |     1,066 |  1 (873 are the target) |
| 872 success claims                |                928 |       153 |                     153 |

Read keys already skipped three quarters of the check results. Of the evaluations left, a mutant's
are mostly of its target check, which the mutant was made to change; a variant's mostly give a
different result (a path, a message or a value that echoes what the edit changed). A perfect
skipping evaluator could avoid at most 343 of 1,864 evaluations. With check runs about a
quarter of the time and generation more than half (ADR 0023's profile, confirmed here), skipping
alone was bounded at about 1.15×.

## Decision

### 1. What a check reads, finely

`fineReadsOf(assertion)` (once per check, `PlannedCheck.fine`) describes each read key further:

- **Tree**: the roles of every locator (matches, targets, scopes, witnesses, `within`, landmarks),
  and among them the roles whose nodes are read beyond their own fields (`deep`): a locator with a
  `text` match, a node's `text` field, a `text` state, scoped text, an unscoped text source in a
  record (the record's role). A `column` locator adds the cell, header, row and table roles, and
  reads rows and tables deeply. `treeOpaque` when the tree cannot be refined: `each` over terms (a
  term's record is the term with its sibling definitions) and any `page` assertion (it selects
  among open pages, whose trees are not described).
- **Page URL**: the whole URL (`url` assertions), a part a `url` source names, a query parameter,
  or the origin or host a storage read defaults to.
- **Network**: the request matches outside a `sequence`; a `sequence` reads the log through the
  trajectory and is not refined.
- **Probes and storage**: each read, with its probe and pointer, or its area, key and origin, and
  its moment (`before` reads the baseline).

Anything the walk does not recognise (an unknown kind or source, a locator whose role is not a
string, a target whose anchors are not a list) makes the check undescribed: it runs whenever a
key it reads changed, as before.

### 2. What an overlay changed

`OverlayChange` holds the base, the overlay and the changed read keys (`changedKeys`), and
describes a key further on first need, once:

- **Tree delta** (`treeDelta`): the trees are compared position by position. The same object is
  the same subtree. Two nodes with the same own fields (every key but `children`, compared as
  strict JSON) are _kept_, and their children compared: identical ones at either end are aligned,
  the rest pairwise when as many remain, otherwise replaced. Any other pair is _replaced_: every
  node of both subtrees is _touched_. A kept node whose subtree changed records its role. The
  delta exists only when both trees are regular (ADR 0016), and it visits at most 64 nodes; an
  edit that reaches further (doubled spaces in every name, main wrapped in a region) touches
  nearly every role anyway and is not described.
- **Network delta** (`networkDelta`): the entries one log has and the other has not, by identity,
  provided the entries both hold are in the same order and neither log holds an entry twice.
- **URL, probes, storage**: compared per read, below.

A check takes the base's result when, for every read key that changed (and no key above it
changed), every read it makes there gives the same value:

| Key                     | Unchanged for the check when                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `a11y`                  | not `treeOpaque`, a delta exists, no touched role is one of its roles, and no kept role is one of its deep roles                |
| `page`                  | not a page assertion, and each URL read gives the same string (a whole URL, a part, a present parameter, origin, host)          |
| `network`               | no `sequence`, a delta exists, and every request match answers `no` for every added or removed entry                            |
| `probes:x`, `baseline…` | each read of the probe: both missing, both failed with the same error, or both working with the same JSON at the pointer        |
| `storage`, `baseline…`  | each read: both records missing, or the same cookies of that name, or the same presence and value of the key at the same origin |
| anything else           | never (`text`, `pages`, `trajectory`, a whole `baseline` or `probes` section)                                                   |

"The same JSON" is strict: the same primitives (`Object.is`, so `-0` is not `0`), and arrays and
plain objects with the same own keys in the same order. Another prototype, a hole or an accessor
that is not the same object counts as different.

### 3. Why skipping gives what re-evaluating gives

A check's result, its message and evidence included, is a function of what it reads (§1); the
outcome is built from the overlay's own snapshot either way. For each key, a skipped check reads
the same values:

- **Tree.** The delta pairs every node outside a replaced subtree with one in the other tree, at
  the same depth, under paired ancestors, in the same document order, with the same own fields;
  a node that is neither kept nor in a replaced subtree has a structurally equal subtree. A locator
  of role R finds only nodes of role R. If R was not touched, the nodes of role R in any paired
  scope are paired with each other, in order, so every locator finds the paired nodes. Their own
  fields and their ancestors' are equal, so names, levels, states, landmarks, `within` tests on
  own fields and paths (labels of ancestors) are equal. Derived text, and the children a column
  header is found through, differ only for kept nodes and nodes in replaced subtrees: a check
  that reads either through a role it reads deeply sees a kept or touched role and runs.
  Anchor consensus, counts, records (other than term groups), and every message built from paths
  follow. Removing, adding, moving, renaming or retyping a node of role R touches R; changing any
  field of a node replaces it.
- **Network.** Matching is per entry; an entry every match answers `no` for is never a hit nor an
  unknown, and the entries both logs hold keep their order, so hits, unknown counts, the picked
  entry and the latest `seq` are the same entries. A matcher that throws on an entry counts as
  seen.
- **URL, probes, storage**: the comparisons in the table are of exactly what the evaluator reads
  (`parseUrl`, `jsonPointer`, `cookiesByName`, the origin a storage read resolves), including what
  their messages echo: an absent query parameter's result shows the whole URL, so it is the same
  only when the URL is.

Undescribed changes are never refined: any exception while describing counts as seen.

### 4. Fallbacks

Re-evaluation, as under ADR 0016, for: an undescribed check; term records and page assertions on
any tree change; trees that are not regular, or edits over the budget; a `sequence` on any network
change; network logs whose shared entries moved or repeat; page text, other pages, the trajectory;
a whole `baseline` or `probes` section replaced. A mutant's target check is evaluated without
trying the description (`PlanRun#check(i, true)`): the mutant was made to change what it reads, so
describing the change would only cost time. Its success claim is described as any overlay.

### 5. Variants nothing reads

Re-checking less does not remove the larger cost, generating overlays. Most generic variants
change parts that no check of the set reads at all (most compiled real-app sets read probes, not
the page): `spacing`, for one, changes nothing any check reads in 92 of its 111 instances. For `extra-content`, `wrap-main`, `spacing` (they change the tree
and the text), `network-noise`, `retry` (network and trajectory) and `extra-storage` (storage),
`stressVariants` tells whether the variant exists without building it, and returns it without a
snapshot when no check reads what it changes. The stress test records it as it would after an
overlay run that reused every check: accepted, with the reference's verdict. Existence is told
only where it is exact and the generator could not throw: a regular tree with string names and
text (`spacing` and `extra-content` always exist, `wrap-main` when there is a main), a network log
of objects with a trajectory that is a list of objects (`network-noise` when the page URL parses,
`retry` when a state-changing request succeeded), and for `extra-storage` the generator's own
decision code, run as it runs. On anything else the variant is built as before, so a malformed
snapshot fails where it failed. `generateVariants` (public) is unchanged and builds every variant.

A variant that is built but changes only what no check reads (a URL fragment when no check reads
the URL) is recorded the same way without an overlay run, unless its tree is not regular (an
overlay run indexes such a tree at once and may throw there).

### 6. Smaller costs

- An overlay's tree is checked for regularity along the nodes it does not share with its base
  (`regularEdit`, `AXTable#regularOver`), without deriving its table, which waits for a check that
  reads the tree. A success claim whose checks all take the mutant's results is never indexed.
- `pairingSwaps` (mutants) looked for the first pair of records that differ in a field by building
  every pair; it now stops at the first, in the same order.

## Consequences

- Results are unchanged. The equivalence test passes against the golden on main (byte for byte,
  every committed snapshot and check set, and the stress test of every committed check set); the
  committed stress reports (`npm run stress` for both set kinds) are rewritten identically.
- New test (`tests/unit/overlay-delta.spec.ts`):
  - every variant, mutant and success claim of every committed check set (not a quarter, as the
    overlay test does), run as an overlay with the descriptions and again with every check
    treated as targeted, against a full run on a copy that shares nothing: the same outcome, byte
    for byte (4,695 overlays; 1,227 check results are reused although a key they read changed);
  - twenty-nine kinds of edit the generators do not make, at nodes of the roles the checks read, below
    nodes whose text they read, and elsewhere, at network entries, probe values at random
    pointers, storage keys and URL parts, at two seeded places each and again on top of each
    (an edit of an edit), on every committed reference: the same comparison (18,968 overlays);
  - case by case on a small snapshot: which checks an edit makes run (a renamed or retyped button,
    a node added beside it, a renamed main, text below a scoped region, a column header, an added
    row, a term's definition, a page assertion, an added matching or unrelated request, a changed
    body, reordered entries, a probe field read or not read, a failing probe, storage keys and
    cookies, a URL fragment, query, origin), and the delta, network delta, URL reads and fine
    reads themselves;
  - variants left unbuilt are those `generateVariants` builds (ids, descriptions, order, on every
    committed reference) and change nothing a check reads; malformed snapshots fail as before.

  Each of nine deliberate faults in the descriptions (not touching a replaced subtree's old
  nodes, ignoring kept nodes, ignoring removed entries, treating an absent parameter as unread,
  ignoring `treeOpaque`, comparing no cookies, ignoring a failing probe, ignoring the origin, not
  reading column rows deeply) was tried; all but the last make the test fail. The last is
  redundant: a change to which header a cell falls under adds, removes or replaces a cell, a row
  or a header, which the column roles already see. It is kept as a margin.

- Check evaluations per pass of all 74 sets: 2,106 before, 1,841 after. Variants: 645 → 503
  evaluations, and 900 of the 1,256 variants no longer get an overlay run (570 are not built, 330
  are built and recorded without one). Success claims: 153 → 30. Mutants: 1,066 → 1,066 (their
  targets).
- Speed. Same machine, `stressTest` as the bench's `stress` workload runs it (inputs parsed afresh
  each pass, garbage collected before it), origin/main's library against this one in separate
  processes, alternating, 8 rounds of 7 timed passes after one warm-up, the median of the round
  medians. The machine was shared (the bench's calibration loop ran at 43–65 ms against 46 ms for
  the committed baseline; single rounds varied by up to ±20%):

  | Workload                                      | Before | After  |
  | --------------------------------------------- | ------ | ------ |
  | `stress`, 44 real-app check sets, median pass | 147 ms | 113 ms |
  | `stress`, 30 example check sets, median pass  | 87 ms  | 74 ms  |
  | `stress`, all 74 check sets, median pass      | 211 ms | 177 ms |

  `scripts/bench.ts --filter stress` with `--lib` (8 alternating runs of 7 iterations): 240 ms
  before, 202 ms after. About 1.2× overall, not the 10× asked for.

- Where the time goes now (a CPU profile of 20 passes, shares of `stressTest`): generating
  mutants about 29% (value mutants: candidate near misses, normalizing and comparing each, JSON
  edits and their keys), evaluating checks about 26% (the cold reference runs, every mutant's
  target, the variant checks whose result really changes), generating variants about 19% (the
  JSON body variants, reordering, formatting), overlay setup about 8%, garbage collection about
  10%. No single function above 3% of self time.
- Why not 10×: skipping was bounded at about 1.15× by what was left after ADR 0016, because most
  remaining evaluations give a different result. Not building unobservable variants is the next
  real lever and is taken where existence is exact; the other generic variants (reordering,
  rows, JSON bodies) decide whether they exist only by building and comparing, and their
  existence is part of the report. A large further gain needs fewer mutants, a cheaper check of
  a mutant's target than evaluating it (it must reproduce the message and evidence byte for
  byte), or running check sets in parallel, which `stressTest`'s synchronous API does not allow.
- An overlay keeps a reference to its base snapshot until its run is dropped, as before. The
  descriptions are computed per overlay and not cached across runs.
