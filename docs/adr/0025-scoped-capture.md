# ADR 0025: Scoped capture

- Status: Accepted
- Date: 2026-11-09
- Scope: `captureScopedSnapshot`, `scopeSnapshot`, `verify` and `verifyMany` (scoped snapshots),
  `loadSnapshot`, `assay capture --scope`, `assay verify`; refusals in `evaluate`, `stressTest`,
  `compileTask` and escalation
- Builds on: [ADR 0015](0015-evidence-store-and-compiled-checks.md) (read-sets),
  [ADR 0016](0016-overlay-stress-and-capture-digests.md) (read keys, and why scoping needs its own
  format)

## Context

A check set usually reads a small part of a snapshot: a probe, a few requests, sometimes the
accessibility tree. The snapshot holds the whole page, every request with its bodies, all storage
and every probe. ADR 0015 named scoped capture (record only the union of a check set's read-sets)
as future work, and ADR 0016 said why it cannot be done by leaving sections out of an ordinary
snapshot: a section that is left out reads as "not recorded" (a check abstains) rather than
"empty", digests change, and the stress test's variants and mutants, escalation and compiling all
expect a full snapshot. A scoped snapshot used for any of those would be silently wrong.

## Decision

### 1. A separate format, `assay.snapshot.scoped/v1`

```jsonc
{
  "schema": "assay.snapshot.scoped/v1",
  "capturedAt": "…",
  "scope": {
    "checkSet": { "id": "tiny-shop/express-order", "version": "1", "content": "sha256:…" },
    "reads": ["network", "page", "probes:latestOrder"], // the plan's read keys (ADR 0016)
    "source": "sha256:…", // the full snapshot's digest, when derived from one
  },
  "page": { "url": "…", "title": "…" }, // always: the outcome reports the URL
  "network": [/* only entries a read request match does not rule out */],
  "probes": { "latestOrder": { "ok": true, "value": {} } },
  "meta": { "capturer": "…", "redacted": [] },
}
```

- **Another schema id**, not a flag on `assay.snapshot/v1`: every reader that predates it, and
  every function that takes a full snapshot, rejects it instead of reading a missing section as
  "not recorded".
- **Tied to one check set** by its content digest (`contentDigest`: the set without its lock or
  rejection). Approving or re-signing the set does not change what it reads, so scoped snapshots
  stay valid across review; any change to a check, requirement or the task does.
- **What is kept**, from the plan's union read-set (ADR 0015) and its read keys (ADR 0016):
  - `a11y`, `text` and `pages` whole, when read (derived text, column headers and locator paths
    read nodes the roles hint does not name, so the tree is not pruned);
  - the network log when read, filtered to the entries for which some read request match is
    `yes` or `unknown`, whole and in log order (so `seq`, counts, bodies and the route ordering
    of ADR 0011 are what they were); `null` stays `null`;
  - storage when read: the cookies with a read name (all domains: the reader decides by domain,
    and two values of one name abstain) and the read keys of local and session storage in every
    origin;
  - the probes read, and of the baseline its URL, metadata and the storage keys and probes read
    `at: "before"`;
  - `page` and `meta` always.
- **Digest**: `snapshotDigest` of the scoped snapshot, as for any snapshot (canonical JSON without
  the capture times). Scoping is deterministic (sections, entries and keys keep their order, the
  read keys are sorted), so the same full snapshot and check set always give the same scoped
  snapshot and digest. A scoped snapshot has its own digest, never the full one's; `scope.source`
  records the full digest when it was derived.

### 2. Making and using one

- `captureScopedSnapshot(page, checkSet, opts)` captures only what is read: the accessibility tree
  and frames only for a tree or text read, `innerText` only for a text read, other open pages only
  for a `page` assertion, storage only for a storage read, only the probes read, and the network
  log settled (its bodies waited for) only for a request read. `assay capture --scope <checks>`
  does the same from the command line.
- `scopeSnapshot(snapshot, checkSet)` derives one from a full snapshot.
- `verify` and `verifyMany` accept a scoped snapshot for the check set it was scoped to. They
  rebuild the evidence the plan reads (sections it does not read are filled with empty values that
  no check of the set reads) and run the plan as usual; the outcome and record cite the scoped
  snapshot's digest. `assay verify` takes one too.

### 3. Misuse fails clearly

| Use                                                    | Result                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `verify` with another check set (or a changed one)     | `ScopedSnapshotError` naming both sets                                                                                                |
| escalation (`verify` with a verifier)                  | never runs: the requirements stay undecided, and the record's escalation has status `error` with "Escalation needs a full snapshot …" |
| `stressTest`, `compileTask`, `scopeSnapshot` of one    | `ScopedSnapshotError`: they need the whole page                                                                                       |
| `evaluate`                                             | an error pointing to `verify`                                                                                                         |
| `loadSnapshot` (and so `gate`, `watch`, `status`, CLI) | an error saying it is scoped, unless called with `{ scoped: true }` (`assay verify` does)                                             |

A scoped snapshot is therefore never evaluated by anything that could read evidence it left out.

## Consequences

- **Same outcome.** Every committed snapshot (the example apps' references and the 228 real-app
  runs), scoped to every check set of its app (5,869 pairs, as in the equivalence test), verifies
  to the outcome of the full snapshot, byte for byte except the snapshot digest. Live, a scoped
  capture of a Tiny Shop page verifies like a full capture of the same page for all ten
  handwritten tasks. Existing snapshots, digests and outputs are untouched: the format is new and
  opt-in.
- **Size**, on the 228 real-app runs, each scoped to its task's compiled check set
  (`node scripts/scoped-capture.ts`):

  | Measure              | Full      | Scoped   | Saved |
  | -------------------- | --------- | -------- | ----- |
  | JSON, all runs       | 21,779 KB | 634 KB   | 97.1% |
  | JSON, median run     | 52.1 KB   | 2.2 KB   | 95.8% |
  | gzip, all runs       | 3,300 KB  | 202 KB   | 93.9% |
  | digest, median run   | 0.620 ms  | 0.024 ms | 96.2% |
  | `JSON.parse`, median | 0.246 ms  | 0.010 ms | 96.1% |

  The compiled real-app sets mostly read probes and a few requests, so most scoped snapshots drop
  the tree, the text and nearly all of the network log.

- **Capture time.** The real apps are not available offline, so capture time was measured live on
  the example apps (`node scripts/scoped-capture.ts --live --repeat 5`: each task's correct run,
  then a full and a scoped capture of the same page, alternating which goes first; median per
  capture, 50 captures per app):

  | App           | Full    | Scoped  | Saved |
  | ------------- | ------- | ------- | ----- |
  | tiny-shop     | 23.7 ms | 13.4 ms | 43%   |
  | tiny-tracker  | 66.5 ms | 10.1 ms | 85%   |
  | tiny-calendar | 26.9 ms | 7.4 ms  | 72%   |

  The savings come from skipping the accessibility snapshot, frames, `innerText`, other pages,
  unread probes and the wait for response bodies. On the real apps, with larger pages and slower
  probes, the share skipped is larger, but that was not measured.

- **What it costs.** A scoped snapshot cannot be stress-tested, escalated, compiled from or reused
  for another check set; that is the trade. Keep full snapshots for references and for runs that
  may need a verifier, and scope the routine ones (CI, monitoring) whose check set is locked.
- **Not done.** The tree is kept whole when read; pruning it to the subtrees the locators can
  reach needs a proof that paths, derived text and column headers are unchanged. Request and
  response bodies are kept whole on the entries kept. A snapshot that holds the trajectory of
  ADR 0024 scopes it like any other top-level section once both are merged: it is kept when a
  check reads the `trajectory` key.
