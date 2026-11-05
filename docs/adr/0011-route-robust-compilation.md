# ADR 0011: Route-robust compilation

- Status: Accepted
- Date: 2026-11-05

## Context

On the real apps (ADR 0009) compiled checks scored 0.974 balanced accuracy, and every error came
from a check set tied to how its one scripted reference did the task:

- `w15-schedule-post`: the `posts` probe has no date field, so the date was checked in the
  reference's Quick Edit request or the post list's row. All three agents scheduled through the
  block editor (a REST request, ending on the editor page), so the correct runs abstained.
- `w13-reply-comment`: "reply to Priya" was only observable in the reference's admin AJAX
  request. An agent that replied through the public comment form got a decided **fail**: a request
  check that matches nothing fails, so escalation never saw the run.
- `w10-add-tag`: "add the tag testing" was read as "testing is among the tags", so a run that
  replaced the existing tag passed.

ADR 0009 listed what to build next: more than one reference route, a missing request that can
abstain, a compile warning for requirements without route-independent evidence, and a decision
on whether "add" keeps what is there. This ADR records how each was built.

## Decision

### Route evidence

A task can usually be done in more than one way through the same app: Quick Edit or the block
editor, the admin comment list or the public post page, an issue's own page or the issue list's bulk
action. Each way sends other requests and ends on another URL. **Route evidence** is what shows
how one run did the task rather than the state it left:

- a `request` assertion,
- a `url` assertion,
- a `value` whose source (or `sameAs` operand) is a `request` or `response`.

Probes and storage are state evidence; the accessibility tree and page text are neither (a node
that is not there already abstains, as an anchor).

### `onMissing: "abstain"` (per check)

A check can declare that it reads route evidence:

```jsonc
{
  "id": "r1-reply-parent",
  "requirement": "R1",
  "description": "The reply was sent as a reply to Priya's comment (id 6), from the admin list or the public form.",
  "onMissing": "abstain", // unset or "fail": today's behaviour
  "assert": {
    "kind": "anyOf",
    "of": [
      {
        "kind": "value",
        "source": {
          "from": "request",
          "match": {
            "method": "POST",
            "url": { "path": "/wp-admin/admin-ajax.php" },
            "requestBody": { "properties": { "action": { "const": "replyto-comment" } }, "required": ["action"] },
          },
          "pick": "last",
        },
        "expect": { "schema": { "properties": { "comment_ID": { "const": "6" } }, "required": ["comment_ID"] } },
      },
      {
        "kind": "value",
        "source": {
          "from": "request",
          "match": { "method": "POST", "url": { "path": "/wp-comments-post.php" } },
          "pick": "last",
        },
        "expect": {
          "schema": { "properties": { "comment_parent": { "const": "6" } }, "required": ["comment_parent"] },
        },
      },
    ],
  },
}
```

With it, **missing** route evidence abstains with the new reason `route_missing` instead of failing;
evidence that was found but is wrong still fails. Precisely, inside such a check:

| Leaf                                       | Missing (abstain, `route_missing`)                                                                  | Found and decided as before                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `request`                                  | no request matches and the count does not accept zero                                               | one or more match: a count bound still fails (one too few, a duplicate submission) |
| `url` with a `path`                        | the page is not on the path's shape (origin, and the path with record ids such as `5` as wildcards) | on that shape: a wrong id, query parameter or `regex` fails                        |
| `url` without a `path`                     | never (a `regex` or query alone names no route)                                                     | decided as before                                                                  |
| `value` from a `request`/`response` source | no request matches the source's `match` (either side)                                               | the body is read and compared: a wrong value fails                                 |
| any other leaf                             | unchanged                                                                                           | unchanged                                                                          |

and an `anyOf` ignores the branches that abstained with `route_missing` when at least one branch did
not: the route the run took decides, and can fail it. When the run took several routes (set the date
through Quick Edit, then again through the editor), only the route whose request came last decides,
since it left the final state; branches that read no request (a probe) keep their say. When every
branch's route is missing, the
`anyOf` abstains with `route_missing`. `allOf`, `each` and the requirement combine with the usual
strong Kleene logic, so a requirement whose route check abstains still **fails when any other
check of it fails** (a probe showing nothing was stored), passes only when every check passes, and
otherwise abstains and escalates under the default policy. The check's message says the run may
have done the task another way, which the verifier gets as its hint.

What a check calls its route is whatever selects the request: `method`, `url`, and for an endpoint
shared by many actions (WordPress's `admin-ajax.php` serves the heartbeat and the dashboard
widgets too) the body field that names the action. The values the task asks for belong in the
expectation of a `value` check reading that request, so that a run which took the route with wrong
values fails. A `request` check whose match also holds the values only abstains on such a run; the
prompt says so.

Why a check setting and not `onFail: "escalate"` (ADR 0004): `onFail` changes only what escalation
does, so the checks-only verdict stays a wrong `fail`, and it cannot tell "this route was not
taken" from "this route was taken with the wrong values". `onMissing` is on the check for the same
reason `onFail` is: it describes evidence, and one requirement can have a route check next to a
state check whose failure must stand. Why not mark every request check: in the example apps the
JSON API is the only route, and a missing `POST /api/orders` is an observed failure; and a view's
URL ("show me the drafts") is the outcome itself, not a route.

The validator warns when `onMissing` is set on a check with no route evidence (it has no effect),
and no longer asks for a companion `request` check for value checks marked `onMissing: "abstain"`
(they are meant to abstain when the request is missing). `reviewSheet` shows the setting, and the
record keeps it per check. `try_assertion` takes it too.

### More than one reference

`compileTask` always took several references; it is now built for references that took different
routes:

- a `Reference` can carry a `note` on how it did the task ("through the block editor"), shown in the
  discovery prompt;
- every check must pass on every correct reference, and the stress test runs on all of them
  (already so);
- **refused:** a check without `onMissing: "abstain"` whose route evidence some correct reference
  lacks (the leaf, evaluated as route evidence, is `route_missing` there). With references through
  different routes that evidence is route evidence by construction, and a run through a third
  route would fail on it;
- **refused** (as before, now also for route evidence): an `anyOf` branch that abstains on every
  correct reference. A branch for a route no reference took is a guess, unverified, which could
  fail a correct run that takes that route with a format the guess got wrong.

The real-app harness stores further scripted references as `reference-<route>` next to
`reference`; `RealTask.alternatives` scripts them, `collect.ts --kinds reference` records them and
`--check-oracles` tests their oracles, `eval/real/compile.ts` passes them all with their notes,
and the evaluation never scores them. Seven tasks got one, where the app has a natural second way
to do the task:

| Task                | `reference`                     | Second reference                                    |
| ------------------- | ------------------------------- | --------------------------------------------------- |
| `w01-publish-draft` | Quick Edit                      | `reference-block-editor`: Publish in the editor     |
| `w07-trash-post`    | the list's Trash link           | `reference-block-editor`: the editor's Actions menu |
| `w10-add-tag`       | Quick Edit's tag box            | `reference-block-editor`: the Tags panel            |
| `w13-reply-comment` | Reply in the admin comment list | `reference-public-form`: Reply on the public post   |
| `w15-schedule-post` | Quick Edit's date fields        | `reference-block-editor`: the editor's date picker  |
| `g02-close-issue`   | the issue page's Close button   | `reference-issue-list`: the list's bulk Close       |
| `s09-mug-quantity`  | typing the quantity             | `reference-spin-buttons`: the increase button       |

For `w13` and `w15` the second route is the one the agents took. That is the point of reference
diversity, and their runs stay held out (other runs, other snapshots), but it means those two
results show that a second reference fixes a known route, not that the compiler generalizes to
an unseen one; `onMissing` is what covers unseen routes.

### Requirements with only route evidence

`coverage` marks a requirement `routeOnly` when every check of it reads only route evidence and at
least one reads the network (a URL alone is a view's state). The compiler then:

- **refuses** it when a probe of a correct reference holds a value its route checks compare (a
  `const`, `enum` or `equals` string, or a literal run of a pattern, of at least six characters
  with a letter) and the probe's baseline did not (so the task wrote it). The state is then
  observable whatever the route, and the error names the probe. Without a baseline there is no
  refusal, since the value may have been there before;
- otherwise **warns**, naming the probes that were captured: "no evidence independent of the
  reference's route … extending one with this state would make it checkable whatever the route".
  This is the probe-coverage review ADR 0009 asked for; `COMPILE.md` marks such requirements †.

The discovery prompt asks for state evidence first and route evidence only for what no probe
shows, or in addition.

### "Add X" keeps what is there

Adding to a collection (a tag to a post, a label to an issue, a product to the cart) means X joins
the collection; it does not replace it. With a baseline, the discovery prompt now asks for a second
check on the same requirement: the collection after, without X, `sameAs` the collection before,
without X. This is a reading of "add", not an unstated condition, and it covers only the collection
X is added to, not "everything else". "Set", "change", "replace" and "move" are not affected. The
rubric prompt is unchanged (still: preservation of other data only when the task says so), so the
requirements stay as they were.

A post's tags are an array inside one record of the `posts` probe, which the `items` normalizer
could not reach member by member. `items` gains `flatten`: the value at `pointer` must be an array,
and its elements become the items. `[{op: "items", where: {…the post…}, pointer: "/tags", flatten:
true}, {op: "items", where: {not: {const: "testing"}}}]` reads the post's other tags. `flatten`
needs a `pointer` and cannot take `pick`.

The stress test's `baseline:no-op` mutant (ADR 0003) was dropped only when the correct run left
the raw value unchanged. A check on the kept tags reads the same normalized value from the correct
run and from "nothing changed", so it was flagged weak although doing nothing is correct for it; the
mutant is now also dropped when the check's normalized value is the same.

### Cassettes that record only what changed

A prompt change used to need `ASSAY_MODEL_MODE=record`, which re-asks every step, including the
rubric, whose new wording would then change requirements and invalidate the verifier's recordings.
With a key and an existing cassette, the scripts now replay what the cassette has and record only
the turns it lacks (`replayOrRecordModel`); a run without a miss leaves the file untouched, and one
with a miss writes exactly the turns it used. A turn it cannot record (the live model is another
model, the call fails, or no live model can start) raises a "no recording" error and changes
nothing, so the evaluation reports the run as not measured instead of scoring a model error. The discovery prompt changed, so discovery was
re-recorded everywhere; the rubric replayed, and every requirement stayed byte for byte the same.

## Results

Recorded on 2026-11-05 with `claude-opus-5-5` at effort `high`, on the same runs, probes and
requirements as ADR 0009 and ADR 0005.

**Real apps** (44 tasks, 177 held-out runs: 129 correct, 48 incorrect):

| System            | Balanced accuracy (before → after) | TPR           | TNR           | Abstain rate  | Cost / run   |
| ----------------- | ---------------------------------- | ------------- | ------------- | ------------- | ------------ |
| checks            | 0.974 → **1.000**                  | 0.969 → 1.000 | 0.979 → 1.000 | 0.017 → 0.000 | $0           |
| checks+escalation | 0.986 → **1.000**                  | 0.992 → 1.000 | 0.979 → 1.000 | 0.000         | $0.0007 → $0 |
| llm-judge         | 0.942 (unchanged)                  | 0.946         | 0.938         | 0.000         | $0.0238      |
| agentic-verifier  | 0.990 (unchanged)                  | 1.000         | 0.979         | 0.000         | $0.0467      |

The five runs ADR 0009 got wrong:

- `w15` (3 agent runs, abstain → **success**): compiled from Quick Edit and the block editor, the
  date check is an `anyOf` over the Quick Edit request and the REST response's `date`, with
  `onMissing: "abstain"`. The agents' REST save decides it; `perturbed-may-fifth` (Quick Edit,
  wrong month) fails on the Quick Edit branch. R2 is still route-only (the probe has no date), and
  the compiler says so.
- `w13/agent-haiku-1` (fail → **success**): "reply to Priya" is an `anyOf` over the admin AJAX
  request and the public form's `comment_parent`, with `onMissing: "abstain"`, next to probe
  checks for the stored reply. `perturbed-top-level-comment` (public form, `comment_parent` 0) now
  fails on the branch of the route it took, where before it failed only because the admin request
  was missing.
- `w10/perturbed-replaced-tags` (success → **fail**): a second check, the post's tags without
  "testing" `sameAs` its tags before without "testing" (`flatten`), fails when `performance` is
  gone. Recording the block-editor reference found the same near miss in WordPress itself: a tag
  typed before the panel has loaded the post's tags replaces them.

The agentic verifier, whose prompt did not change, still accepts `w10/perturbed-replaced-tags`; the
LLM judge's ten errors are unchanged. Both replayed from their cassettes, since no requirement
changed. No compiled set abstains on a held-out run any more, so escalation made no model call
(the three `w15` escalation recordings were removed).

**Compiling:** all 44 tasks compile, seven from two references, for $7.44 as recorded (ADR 0009:
$6.67); the compile script judges all 177 held-out runs correctly. Five checks carry
`onMissing: "abstain"` (`g08`, `w13`, `w15`, two in `s15`), and 74 of 84 requirements have a probe
check. Four requirements are route-only and warned about: `w15` R2 (no date in `posts`) and the three
of `s15` (PrestaShop has no cart-rule probe). One of those `s15` checks was not marked
`onMissing` (a single reference gives the compiler no proof of a second route), so a run creating the
rule another way would still fail it. Stress on all references: 560/560 valid variants, 396/397
mutants (the remaining one is ADR 0009's weak `s08` product-list check).

The recompile also exposed a runtime bug. `s01-add-cushions` counted cart lines with `minContains`
and `maxContains`, which Ajv's default draft-07 mode ignored silently, so a cart with one cushion
passed for "add two" (the stress test already mutated those keywords as if they held). User schemas
are now compiled as draft 2019-09, where draft-07 schemas mean the same; the draft-07 meta-schema
is registered, so a schema that declares `"$schema"` draft-07 still compiles.

**Examples** (30 tasks, 96 held-out runs): unchanged at 1.000 for checks and checks+escalation,
0.906 for the judge and 0.976 for the verifier. The new prompt first made three Tiny Shop order tasks
check the order only through a `latestOrder` probe, which errors before any order exists, so the
spoofed confirmations abstained instead of failing. A section appended only when no reference has a
baseline or a probe failed in one (none of the real tasks) asks for a check that fails when nothing
was created; with it, all 96 runs are judged correctly. Compiled stress: 671/671 valid variants,
385/385 mutants (365 by fail, 20 by abstain; before: 673/673, 405/405). Compile cost $4.17.

**Spend:** about $14.6 live: real compile $7.44, examples $4.17, a trial recompile of three
WordPress tasks ($0.58) and of three Tiny Shop tasks before the absence section, and an aborted first
pass over 16 example tasks (about $2.4). The evaluations replayed (no escalation call). The second
references were scripted, with no agent run.

## Consequences

- A requirement whose only evidence is one route's request now abstains and escalates for a run
  that went another way; it fails only when that route was taken with the wrong values, or when
  state evidence fails it. Escalation therefore sees runs it used to miss, at a small model cost
  per such run.
- Route-only requirements remain where probes lack a field (`w15`'s date, `w13`'s reply parent).
  The warning names them; the fix is the probe, which this change deliberately did not touch, so
  the comparison with ADR 0009 stays on the same runs and probes.
- Adding references costs a scripted run per route and a little more compile time; the compiler
  cannot invent routes it has not seen, and a guessed branch is refused.
- "Add" keeps what is there by default now. A task that means replacement must say so ("set the
  tags to …"); a reviewer sees the second check in `reviewSheet` and can drop it.
