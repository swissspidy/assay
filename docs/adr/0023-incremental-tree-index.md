# ADR 0023: Incremental accessibility-tree index for stress overlays

- Status: Accepted
- Date: 2026-11-09
- Scope: the accessibility table (`src/store/ax.ts`), `AXIndex` (`src/runtime/axindex.ts`), tree
  edits (`src/stress/edit.ts`), the variant and mutant generators, `compare`
- Builds on: [ADR 0015](0015-evidence-store-and-compiled-checks.md),
  [ADR 0016](0016-overlay-stress-and-capture-digests.md)

## Context

ADR 0016 made variants and mutants overlays on their reference, and left one item open: an
index of an edited tree that copies the reference's rows for the subtrees the edit shares. The
expectation was that each variant rebuilding its index, and its regularity check, from scratch
was most of what stress still cost. The goal set for this work was a 10× faster stress test.

### What the profile showed

A CPU profile of the `stress` bench workload (74 check sets, 177 references, Node 24, 40 passes
so the warm-up does not count) and timers around each phase of `stressTest` gave, per pass:

| Phase                                         | Share |
| --------------------------------------------- | ----- |
| Generating mutants                            | ~29%  |
| Generating variants                           | ~20%  |
| Running checks on variants                    | ~16%  |
| The reference's own run (cold plan and index) | ~14%  |
| Running checks on mutants                     | ~11%  |
| Success claims (generation and checks)        | ~9%   |

Tree work across all phases (the whole-tree walks of six generic variants, `regularTree` on every
overlay, building tables and indexes, `sameJson` on edited trees) was about a quarter of the
total; table and index construction alone about 7%. The committed trees are small (median 57
nodes, largest 484), so a full index is cheap. The rest is spread thin: normalizers and
comparisons over candidate values, near-miss generation, JSON pointer edits, outcome objects,
garbage collection (about 10%). No single function above 4% of self time.

Two costs stood out among the tree work: `regularTree` adds every new node to a `WeakSet`
(about 350 ns per node, mostly creating the node's identity hash), and the generic variants
`reorder`, `reorder-terms`, `extra-content`, `extra-row`, `wrap-main` and `spacing` walked and
compared the whole tree. Outside the tree, `compare` wrote the whole compared value
(`describeValue`, a `JSON.stringify` of an entire body) for a message that the mutant generators
then dropped, and every date parse constructed an error, with its stack trace, in case the date
was invalid.

## Decision

### 1. Derived tables

`AXTable.of(tree)` caches one table per tree object (the index and the edits share it). A tree
recorded as an edit of another (`noteDerived(next, from)`, called by `editById`, its targeted
path, and the few generators that build a root by hand) gets a table **derived** from the last
recorded ancestor that has a table, which is the reference's for every variant, mutant and claim:

- A subtree whose root is one of the base's node objects is the same subtree (trees are not
  edited once indexed, ADR 0015). Its rows are copied: role and interned name verbatim, parent,
  end and depth shifted. Sibling subtrees that are consecutive in the base too copy as one range.
- Only the nodes the edit made are visited. Each is checked as `regularTree` checks it (a plain
  object, an own non-empty `children` list without holes, or none). If one is not, or the base's
  tree is not regular, there is no derived table and the tree is built from scratch, which throws
  where it always threw.
- A derived table shares its base's role and name interners. Ids only grow, so they stay valid;
  a role slice sorted before another table added a role answers that role with no nodes.
- Columns go into shared 64 KB slabs: one `ArrayBuffer` per table cost more than deriving it.
- `regularTree(root)` answers from the tree's table when it has one or can derive one (a derived
  table is regular by construction), and walks the tree otherwise, as before.

`AXIndex.of(tree)` builds its nodes over `AXTable.of(tree)` and copies the derived text and
canonical text the base index already computed for the copied subtrees (they depend on the
subtree alone). Paths depend on ancestors and are not copied. `new AXIndex(tree)` still builds
from scratch.

### 2. Edits by id work on the table

`editById(s, fn, only)` on a regular tree walks the paths to its targets through the table's
`parent` and `end` columns instead of the index's node objects, so a mutant tree that gets a
success claim is never indexed for it. The six generic tree variants now pass the ids their
callback can edit (picked from the table by role, by name or as parents of terms), so they
rebuild only those paths and share the rest; `sameJson` then compares shared subtrees by
identity. A tree that is not regular is walked whole, as before.

### 3. Smaller per-candidate costs

- `compareOk(v, cmp)`: `compare(v, cmp).ok` without describing the value or building the
  message, the same tests in the same order. The mutant and near-miss filters use it.
- Date parsing makes its error only when it throws.
- Unchanged network entries and probe results stay the same objects in the JSON-body variants;
  the unrelated content of `extra-content` and `extra-frame` is built from a literal instead of a
  structured clone; `pairingSwaps` compares fields with `sameJson`.

## Consequences

- Results are unchanged. The equivalence test passes against the golden on main (byte for
  byte, every committed snapshot and check set, cold and warm, and the stress test of every
  committed check set); the overlay test, the committed stress reports (`npm run stress` for
  both set kinds rewrites them identically) and the compile replays are unchanged.
- New test (`tests/unit/incremental-index.spec.ts`): eleven kinds of tree edit (rename, role
  change, removal, insertion, a subtree duplicated elsewhere, wrapping, replacement by a copy,
  reversed children, dropped children, a new root, several edits at once), each at seeded random
  nodes of every committed reference, then edited again; and every variant, mutant and claim of a
  quarter of the committed check sets. Every lookup of the derived index (columns, roles,
  canonical names, text, paths, column headers, descendants, role and role-and-name slices,
  locator matches, regularity) must equal one built from scratch on a copy. Trees that are not
  regular are shown never to be derived.
- Speed. Same machine, `stressTest` as the bench's `stress` workload runs it, origin/main's
  library against this one, alternating, 8 rounds of 7 timed passes (after one warm-up), the
  median of the round medians. The machine was shared with other jobs throughout (the bench's
  calibration loop ran at 60–77 ms against 46 ms for the committed baseline), so differences
  under about 5% are noise:

  | Workload                                      | Before | After  |
  | --------------------------------------------- | ------ | ------ |
  | `stress`, 44 real-app check sets, median pass | 157 ms | 143 ms |
  | `stress`, 30 example check sets, median pass  | 88 ms  | 82 ms  |
  | `stress`, all 74 check sets, median pass      | 244 ms | 231 ms |

  By phase: generating variants about 15% less, running checks on variants about 24% less,
  generating mutants about 9% less; the reference runs, mutant checks and claims unchanged.
  Overall about 1.1×, not the 10× asked for.

- Why not 10×: the premise did not hold. Tree indexing was a small part of stress, and
  everything tree-related together about a quarter; removing all of it would give at most about
  1.3×. What remains is the generators' semantic work (near misses per comparison, normalizing
  and comparing each candidate, JSON edits), running the checks each overlay touches, the cold
  first run per reference, and garbage collection, spread over hundreds of functions. A large
  further gain needs fewer candidates or checks per overlay, which changes the reports, or a
  dependency tracking of what each check read in the tree (re-run a check only when an edit
  touches a node it looked at, including the candidates a locator rejected and the ancestors a
  path names), which is the next step if stress speed matters again.
- Memory: a derived table keeps its base table alive, and a slab stays allocated while any
  table in it is reachable (at most 64 KB per retained table).
