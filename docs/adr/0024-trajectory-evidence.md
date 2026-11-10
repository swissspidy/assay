# ADR 0024: Trajectory evidence and `sequence` checks

- Status: Accepted
- Date: 2026-11-09
- Scope: `EvidenceRecorder` and `captureSnapshot` (the optional `trajectory`), `assay capture
  --trajectory`, the check DSL (`sequence`), the validator, read-sets, the evaluator, the stress
  test, the builder and printer, the review sheet, the compiler's discovery tools
- Builds on: [ADR 0001](0001-evidence-snapshot-and-check-dsl.md), [ADR 0011](0011-route-robust-compilation.md),
  [ADR 0012](0012-snapshot-frames-pages-bodies.md), [ADR 0015](0015-evidence-store-and-compiled-checks.md),
  [ADR 0016](0016-overlay-stress-and-capture-digests.md)

## Context

Assay judges the state a run left behind. Some requirements are about how the run got there:
"verify the patient's identity before refilling", "confirm before deleting", "add every item
before checking out". The end state of a run that refilled first and verified afterwards is the
end state of a correct run: both requests were sent and both succeeded. No check on the end
state can tell them apart.

What a snapshot already records:

- Every network entry has a `seq`, the order in which the recorder saw the request start. So the
  relative order of two requests is in every snapshot.
- Nothing records navigations. The recorder watches main-frame navigations to pick the active page
  (ADR 0012), but keeps only a counter.
- No entry has a time.

## Decision

### 1. The trajectory (`snapshot.trajectory`)

A recorder attached with `{ trajectory: true }` records an ordered event log, and snapshots it
captures carry it as `trajectory`:

```ts
type TrajectoryEvent =
  | { type: 'request'; seq: number; t: number } // a request started: the network entry with this seq
  | { type: 'navigation'; url: string; page: number; t: number }; // a main frame navigated
```

- **Order.** The position in the array is the event's order index. Events are appended in the
  order Playwright reports them (`request`, and `framenavigated` on a page's main frame), which is
  the browser's order.
- **Requests point at the log.** A request event names its network entry by `seq` rather than
  copying it, so the trajectory adds a few bytes per request and the network log stays the one
  record of what was sent. A request event whose entry the log does not hold matches nothing.
- **Navigations** cover full loads and same-document history changes (`pushState`), which
  Playwright reports as navigations too. `page` numbers the pages in the order the recorder saw
  them (0 is the first). They were nearly free: the recorder already listened for them.
- **Times.** `t` is whole milliseconds since the recorder was attached (a monotonic clock). It is
  kept for people and tools; no check reads it (ADR 0001: checks never read the clock).
- **Opt-in and backward compatible.** Without the option the key is left out, not `null`, as
  `baseline` and `pages` are, so every existing snapshot and its digest are unchanged. A snapshot
  with a trajectory has a different digest from the same snapshot without one, as it should: it
  holds more evidence. `loadSnapshot` checks the trajectory's shape.

Request order alone was in `seq` already, so why a new section? Because a `sequence` check needs
to know that order was recorded on purpose, and needs navigations interleaved with requests.
Reading `seq` from snapshots that did not opt in would have given old snapshots an order check
without anyone asking for one, and would have left navigations out. With the section, "no
trajectory" is a clear reason to abstain.

### 2. The `sequence` assertion

```jsonc
{
  "kind": "sequence",
  "steps": [
    { "request": { "method": "POST", "url": { "path": "/api/verify" }, "status": 200 } },
    { "request": { "method": "POST", "url": { "path": "/api/refill" } } },
  ],
  "strict": false, // optional
}
```

A step is `{ "request": RequestMatch }` (a request event, matched through its network entry, with
the three-valued matching of ADR 0001) or `{ "url": UrlMatch }` (a navigation event's URL). There
must be at least two steps.

**Semantics.** Let `first(k)` be the index of the first event that matches step `k`.

- **Pass** when `first(1) < first(2) < … < first(n)`. Equivalently, every event of step `k+1`
  has an event of step `k` before it, so "every refill has a verification before it": a run
  that refills, verifies, then refills again fails, because its first refill was not verified.
- **`strict`**: in addition, every event of step `k` comes before `first(k+1)`. The steps do not
  interleave ("add all items, then check out": no add after the checkout began).
- **Fail** when the order is violated, or when a step never occurs. A step that never occurs is an
  observed absence of the network log or the navigation history, like a `request` check with no
  match.
- **Abstain** when the snapshot has no trajectory, or has request steps and no network log
  (`evidence_unavailable`), or when unreadable bodies leave the order undecided
  (`value_unavailable`). An event whose match is `unknown` counts both ways: the check passes only
  if it would pass for every resolution, and fails only if it would fail for every resolution, as
  `request` does with its count interval. A definite violation fails whatever is unknown.
- **Route evidence (ADR 0011).** A sequence reads how the run went, so `onMissing: "abstain"`
  applies: when no step occurs at all, it abstains with `route_missing`. A step that occurs
  without the one before it still fails: that is the order the check is about.

**Why this design.** It is the smallest one that says what the requirements say:

- `before: {a, b}` was the alternative. It is a two-step `sequence`, but a chain of three steps
  would need three such checks, whose failures would not say which link broke.
- Existence of _some_ ordered subsequence (an `a` somewhere before a `b`) is weaker and wrong for
  the motivating cases: a run that refills, then verifies, then refills again has one, but its
  first refill was unverified. "First occurrences in order" catches it with no extra operator.
- Contiguity (no other event between steps) is useless on real pages, which send analytics,
  polling and asset requests between any two actions.
- Times are not compared. A duration requirement ("within 5 seconds") would make a check depend
  on machine speed; none of the motivating requirements needs one.
- The steps reuse `RequestMatch` and `UrlMatch`, so their validation, loose-match warnings,
  descriptions and builders already exist.

**Placement.** A sequence reads the whole run, so it is an error inside an `each` (the same for
every record) and inside a `page` assertion (it does not read the page).

**Validation warnings.** Two adjacent identical steps are an error (their first events are one
event, so they can never be in order). A request step without a `url` draws a warning: any request
can stand for it, including an earlier, unrelated one, and the order is not tested. A strict
sequence with a GET step draws a warning: a page that fetches that data again (polling, a refresh)
fails it. The loose-match warnings of ADR 0001 apply to each step.

### 3. Read-sets, plans and overlays

`ReadSet` gains `trajectory`. A sequence sets it and lists its request steps under `requests`
(they match through the log), so `readKeys` gives `trajectory` and, with request steps,
`network`. `changedKeys` already reports any replaced top-level section, so an overlay that
reorders the trajectory re-runs exactly the sequence checks (ADR 0016). The evaluator is one more
compiled run in `src/plan/assertions.ts`; the evidence store needs nothing new.

### 4. Stress test

Mutants, made from a correct reference on which the sequence passes (`src/stress/trajectory.ts`):

| Mutant                | Edit                                                                                     | Catches                                         |
| --------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `sequence:swap`       | the first events of two adjacent steps trade places                                      | a check that does not test order                |
| `sequence:late`       | the later step's first event moves just before the last earlier-step event preceding it  | a step that an earlier, unrelated event matches |
| `sequence:interleave` | strict only: an earlier step's last event moves to just after the next step began        | a strict check that does not enforce strictness |
| `sequence:missing[k]` | step `k` never happened (its events, and the network entries of a request step, removed) | a check that passes without a step              |

`late` exists only where the earlier step matched more than one event before the later one. A
precise step matches its own event once, so it gets no `late` mutant; a loose one (matching the
page's own GET as "the verification") does, still passes it, and is reported as weak. Times stay
at their positions when events move, so a mutant's trajectory stays monotonic.

Valid variants: `trajectory-noise` puts an unrelated request (an analytics beacon) between every
two events; a sequence must still pass. The `retry` variant, which renumbers the log, and
`network-noise`, which appends to it, now keep the trajectory pointing at the same requests (a
retried request's failed attempt sits just before it). Snapshots without a trajectory get none of
this, so the committed stress reports are unchanged.

### 5. Builder, printer, review sheet

`sequence(...steps)` takes `network.post(...)` (any `RequestRef` without a count), `url(...)` or a
plain step, and `.strict()` sets `strict`. `assay checks print --ts` prints it back.
`describeAssertion` says "in this order in the run's trajectory: a request POST, path /api/verify,
then a request POST, path /api/refill", with "(strict: …)" when strict. Coverage counts request
steps as network evidence and URL steps as URL evidence.

### 6. Compiler

The discovery agent sees the `sequence` assertion, a `DISCOVERY_TRAJECTORY` prompt section and a
`trajectory` tool only when a reference has a trajectory, the way it sees `page` only for
references with other open pages. Cassette keys are the canonical JSON of the full model request
(prompt and tool schemas), so committed replays, whose references have no trajectory, stay byte
for byte as they were: `dslDefinitions` leaves `sequenceStep` and the `sequence` alternative out
unless asked for them. Mining (ADR 0020) does not propose sequences.

### 7. Fixture

`examples/refill` is a tiny pharmacy whose backend accepts a refill whether or not the identity was
verified first. Its references, captured with `node examples/refill/capture.ts`, are a correct run
and a run that does the same two steps in the other order: same requests, same responses, same
probe, same final page. `examples/refill/refill.checks.json` checks the refill (request and
probe) and the order (`sequence`); only the sequence check fails the second run. The fixture is
not one of the example apps, so the evaluation, the equivalence golden and the committed stress
reports do not include it.

## Consequences

- Process requirements can be checked deterministically when the capture opts in. On a snapshot
  without a trajectory a sequence abstains and escalates, as any check on evidence that was not
  captured does.
- Existing snapshots, digests, check sets, stress reports, evaluation replays and compile replays
  are unchanged: the equivalence golden passes byte for byte.
- The trajectory is evidence the app can influence only through what it requests and where it
  navigates, the same trust as the network log and the URL. A page cannot add a request event: the
  recorder appends them from Playwright's own events, as it does network entries.
- Not done: clicks and other user events (they need an init script in every frame, and the
  requests and navigations they cause are what the requirements name); per-occurrence pairing
  ("each delete confirmed by its own confirmation"); duration bounds.
