# ADR 0015: Evidence store and compiled check plans

- Status: Accepted
- Date: 2026-11-06
- Scope: runtime (evaluation of checks), `verify`, the new `verifyMany`, stress testing

## Context

Deterministic verification is meant to take milliseconds (ADR 0004). It does, but most of that
time goes to work that does not depend on the pair being verified. On the 228 real-app runs
(ADR 0009) `verify` took about 1.4 ms per run, and a CPU profile showed where:

- **Digests**, about 60%. `evaluate` recomputed the snapshot digest (canonical JSON of the whole
  snapshot, then SHA-256) and the check-set digest on every call.
- **Validation**, about 10%. `verify` re-validated the check set on every call, and Ajv recompiled
  each embedded JSON Schema for every fresh copy of a set.
- **Indexing and matching**. Each `evaluate` rebuilt the accessibility index. Every locator walked
  all descendants of its scope and canonicalized each candidate's name (NFC, whitespace) again.
  Request matching parsed each entry's URL once per matcher and keyed the schema cache with the
  canonical JSON of the schema, per entry.

Verifying many runs with one check set (evaluation, CI, the stress test, a later delta stress test)
repeats all of this per run. The evaluator also had no description of what a check reads, which
delta stress testing (re-evaluate only what an edit touches) and scoped capture (capture only what
a check set reads) both need.

The constraint is ADR 0001's: checks are pure functions of the snapshot. Every verdict, message,
evidence pointer and record must stay byte-identical. Only timings may change.

## Decision

Split evaluation into the parts that depend only on the snapshot (an **evidence store**, built once
per snapshot) and the parts that depend only on the check set (a **check plan**, compiled once per
check set). Evaluation runs a plan against stores. `verify`, `evaluate` and `stressTest` keep their
signatures and results, and go through plans and stores.

### 1. Evidence store (`src/store`)

```ts
class EvidenceStore {
  readonly snapshot: EvidenceSnapshot; // never copied, never edited
  get ax(): AXIndex; // the active page's tree, as an AXTable
  axOf(tree: AXNode): AXIndex; // another open page's tree
  get network(): NetworkTable | null; // null: not recorded
  get pages(): PageView[]; // active page first
  cookies(s: StorageRecord): ReadonlyMap<string, readonly CookieRecord[]>; // by name
  get digest(): string; // === snapshotDigest(snapshot)
  get sectionDigests(): Readonly<Partial<Record<Section, string>>>;
}
buildStore(snapshot): EvidenceStore; // cached in a WeakMap keyed by the snapshot object
```

**Accessibility tree as columns** (`AXTable`): one row per node, numbered in pre-order. These are
the same ids `AXIndex` always used and that stress edits address.

| Column       | Type                     | Meaning                                                              |
| ------------ | ------------------------ | -------------------------------------------------------------------- |
| `role`       | `Uint32Array`            | interned role                                                        |
| `parent`     | `Int32Array`             | parent id, `-1` for the root                                         |
| `depth`      | `Uint32Array`            | root is 0                                                            |
| `end`        | `Int32Array`             | one past the subtree's last id: the subtree is `[id, end[id])`       |
| `name`       | `Int32Array`             | interned `canonical(name)`; filled on first read                     |
| `nodes`      | `AXNode[]`               | the node objects, for fields read rarely (states, value, url)        |
| `byRole`     | `Int32Array` + offsets   | ids sorted by role, then id: a slice per role; built on first lookup |
| `byRoleName` | `Map → Map → Int32Array` | ids by role and canonical name; built per role on first lookup       |

Invariants:

- Ids are pre-order. `parent[i] < i`, the descendants of `i` are exactly `i+1 … end[i]-1`, and
  every id list is ascending. So "descendants of the scope with role R" is two binary searches in
  R's slice of `byRole`, and results come out in document order, as the tree walk produced them.
- `name[i]` is `canonical(nodes[i].name)`, the form `matchText` compares. A locator that names a
  node exactly (a string, or `equals` without `ignoreCase`) looks it up in `byRoleName`. Any other
  match tests the candidates of its role, in order.
- Derived text, its canonical form and paths are cached per id. Term groups (ADR 0008) are made
  anew per read, as before, and cached only weakly.
- A name that is not a string (a malformed snapshot) is never interned. Its role falls back to the
  scan, which throws where the old evaluator threw.

`AXIndex` keeps its interface (`root`, `all`, `find`, `records`, `text`, `path`, `columnHeader`,
...) as a view over the table, so the compiler and stress generators are unchanged. `AXIndex.of(tree)`
caches one per tree object.

**Interning.** Each table has two `Interner`s (string → small integer): roles, fixed once the table
is built, and canonical names, added to as names are first read. Role and exact-name tests compare
integers, and a role or name that occurs nowhere in the tree fails its lookup without a scan.
Tables never share ids. A later on-disk format writes the string tables once (§5).

**Network as a table** (`NetworkTable`): the entries in capture order, an index from upper-cased
method to entry ids, and URLs parsed once (`ParsedUrl`: origin, path segments, decoded segments,
cached by href across stores). A request match visits only entries with an accepted method and
tests the rest in the old order, so a match that cannot apply still says `no` first. Bodies are
read through `body(i, which)`. In a parsed snapshot they are values already. A store read from
bytes (§5) keeps each body's raw text and parses it on first read. Nothing in this PR reads bodies
from bytes.

**Storage, probes, text, pages, frames.** Cookies are indexed by name per storage record (the
snapshot's and the baseline's). Local and session storage, and probes, are already maps. The page
text with horizontal whitespace collapsed is cached per string. Other pages' trees get their own
`AXIndex`. Frame content is part of the tree (ADR 0012), so frames need no index of their own.

**Content addressing.** `store.digest` is `snapshotDigest(snapshot)`, computed once, and the record
uses it. `sectionDigests` gives the SHA-256 of each top-level section's canonical JSON (the
baseline's without its capture time). Sections can then be addressed and compared by digest, which
the delta formats below need. The plan's `digest` is `checkSetDigest`, computed once.

**Immutability.** A store reads the snapshot in place, so a snapshot must not be edited once it
has been verified. Edit a copy instead, as the stress generators always have. The same holds for
check sets and plans. Caches are keyed by object identity, so a copy (a re-parsed file) gets its
own store or plan.

### 2. Compiled check plans (`src/plan`)

```ts
compileChecks(checkSet): CheckPlan; // cached in a WeakMap keyed by the check-set object
class CheckPlan {
  readonly checkSet: CheckSet;
  get report(): ValidationReport; // validateCheckSet, once
  assertValid(): CheckSet; // throws CheckSetError, as assertValidCheckSet
  get digest(): string; // checkSetDigest, once
  get checks(): { check: Check; run: () => Run; readSet: ReadSet }[];
  get readSet(): ReadSet; // union of the checks'
  lockStatus(cs, opts): LockStatus; // verifyLock, once per set of trusted keys
}
runPlan(plan, store, opts?): Outcome; // what evaluate returns
```

- **Validation once.** `verify` validates through the plan, so a check set is validated once per
  object. Schemas that compiled are remembered by their JSON, so a re-parsed copy of a set no longer
  makes Ajv compile every embedded schema again (schemas that register an `$id` or anchor are not,
  since compiling those twice fails).
- **Prepared assertions.** `compileAssertion(a)` turns an assertion into a function of the
  evaluation context, once per assertion object. Its targets and locators are compiled
  (`CompiledLocator`: text matches canonicalized, regexes built, the exact name for the index, the
  description for messages). Its URL, page and request matchers are built, its normalizer chains
  resolved, its schemas compiled, and its comparisons bound.
- **One implementation.** The compiled form is the evaluator. `evaluateAssertion`, `readValue`,
  `bindingSides` and `pageContext` call it, so the compiler and stress generators see the same
  semantics.
- **Failures stay where they were.** Everything is prepared on first use, at the point where the
  old evaluator computed it, and a preparation that throws is not kept (`once`). So a malformed
  check that only `evaluate` (which does not validate) can see throws the same error in the same
  place. It still becomes an abstention with the same message.
- **Declared read-sets.** `ReadSet` is derived from the check alone. It lists the active page's
  tree, text and URL, other open pages, the request matches, the storage keys (area, key, origin,
  before/after), the probes, and as a hint for capture the roles its locators name. Evidence outside
  a check's read-set cannot change its result. This PR only exposes read-sets: delta stress and
  scoped capture will use them.

### 3. `verify` and `evaluate`

`verify` compiles (or reuses) the plan, validates through it, checks the lock through its memo,
builds (or reuses) the store and runs the plan. The rest (escalation, merging, the record) is
unchanged. `evaluate(checkSet, snapshot)` is `runPlan(compileChecks(checkSet), buildStore(snapshot))`.
`stressTest` keeps calling `evaluate` on its variants and mutants. Each one is a new snapshot and
gets a store with lazily built sections, and the plan is shared.

### 4. Batch API

`verifyMany(checkSet, snapshots, options?)` returns what `snapshots.map((s) => verify(checkSet, s,
options))` returns, in order. It validates and checks the lock once. It evaluates **check by
check**: each check's prepared assertion runs on every store before the next check, so the
check's matchers and the stores' indexes it touches stay hot. Escalation, proposals and records
then follow per run, in order. A snapshot whose tree cannot be indexed throws before any run is
escalated, where the mapped calls would have escalated the runs before it. `checksMs` is the
time spent on that run's checks.

### 5. Out of scope, for later PRs

- **Overlay (delta) stress.** A variant or mutant becomes an overlay on its reference's store: the
  edited rows and sections, with everything else shared. Only the checks whose read-sets the edit
  touches are re-evaluated. Today every variant is a `structuredClone` of the whole snapshot with
  its own store.
- **Scoped capture.** Capture only the union of a check set's read-sets (no full network log or
  tree when the checks read three requests and a probe).
- **Binary on-disk format.** A store serialized as one file:
  - a header, then the string table (UTF-8, offsets), then each column as a little-endian typed
    array, aligned;
  - network bodies as raw byte ranges, parsed on first read, which is what `body(i)` is for;
  - section digests in the header, so a store can be checked and deduplicated by section without
    parsing it.

  Loading would cost a few `subarray` calls instead of gunzip, JSON.parse and indexing (about 2 ms
  of the 3 ms a real-app run costs now). It was not built here: it needs a versioned format, a
  writer in capture and a reader that still produces `snapshotDigest`-identical digests, and none
  of that falls out of this change. JSON snapshots remain the format of record.

- **Mining-first compiler.** A compiler that runs candidate checks as plans over many stores before
  asking a model.

## Consequences

- Results are unchanged. `tests/unit/equivalence.spec.ts` runs `verify` on every committed
  snapshot (the example apps' references and the real-app runs) with every check set of its app:
  5,869 pairs, cold and warm. It also runs `stressTest` on all 104 committed check sets. The
  outcomes, checks-only outcomes and records (without id, time and timings) match, byte for byte,
  what the evaluator at the commit before this change returned (`golden.json.gz`, written by
  `generate.ts` from that commit). The committed stress reports, the keyless evaluation replays
  and the compile replays are unchanged.
- Speed on the 228 real-app runs. Node 24, one script, the commit before and after on the same
  (shared) machine, alternating. Each figure is the median over three rounds of a round's median
  over 7 repetitions:

  | Path                                                            | Before  | After    |
  | --------------------------------------------------------------- | ------- | -------- |
  | `verify`, warm (same snapshot and check-set objects)            | 1.29 ms | 0.037 ms |
  | `verify`, cold (a fresh snapshot object: store, index, digest)  | 1.48 ms | 1.21 ms  |
  | `verify`, cold check set too (both parsed again)                | 3.52 ms | 1.50 ms  |
  | `verifyMany`, warm, per run                                     | n/a     | 0.038 ms |
  | `stressTest`, the 44 real-app check sets on their training runs | 0.47 s  | 0.45 s   |

  The cold path is now mostly the snapshot digest (canonical JSON and SHA-256 of 50–900 KB, about
  1 ms), which the record needs. A hand-written canonical encoder was not faster than
  `JSON.stringify` of a key-sorted copy. A warm `verify` is mostly building the outcome and the
  record, so `verifyMany` adds little per run over warm `verify` calls. Stress is unchanged: it is
  dominated by copying and editing snapshots (`structuredClone`, tree edits) and by Ajv compiling
  the schemas that mutants generate, which overlay stress (§5) addresses.

- Snapshots and check sets must not be edited after they have been verified. This is documented
  on `buildStore` and `compileChecks`. The stress generators and the compiler always edit copies.
- Memory: a store holds its indexes for as long as the snapshot lives. Parsed URLs, regexes and
  compiled schemas are cached process-wide, each cache bounded (cleared when full). Ajv's own
  schema cache is cleared together with ours, and the check-set validator drops each schema from
  its Ajv once it has compiled.
