# Assay

Compiled outcome verification for web agent tasks.

A model verifies a task outcome once, at authoring time. The result is
compiled into deterministic checks that run in milliseconds with no model. A
check returns **pass**, **fail** or **abstain**. Abstain means the check
couldn't find or read its evidence, and it triggers escalation to an
expensive verifier.

> Status: **milestone 1**: snapshot format, check DSL and runtime. The
> compiler, stress testing, escalation and evaluation come next.

- Design: [ADR 0001: Evidence snapshot format and check DSL](docs/adr/0001-evidence-snapshot-and-check-dsl.md)
- Example check sets: [`examples/tiny-shop/tasks/`](examples/tiny-shop/tasks)

## Quick start

```ts
import { test, expectOutcome } from 'assay/playwright';
import checks from './checks/express-order.checks.json';

test('agent ordered with express shipping', async ({ page }) => {
  await runMyAgent(page, 'Order what is in my cart with express shipping.');
  // Records the network from context start (auto fixture). Captures a
  // snapshot and evaluates the checks, polling until success or timeout.
  await expectOutcome(page, checks, {
    probes: { latestOrder: () => page.request.get('/api/orders/latest').then((r) => r.json()) },
  });
});
```

Offline, against a stored snapshot:

```ts
import { loadSnapshot, verifySnapshot, formatOutcome } from 'assay';
const outcome = verifySnapshot(checks, loadSnapshot(json));
console.log(formatOutcome(outcome));
```

## A check

Checks are JSON data, not code. Every check traces to a requirement, and
every requirement quotes the task text it comes from:

```json
{
  "id": "C1",
  "requirement": "R1",
  "description": "The 'Cart total' output shows US$21.50 (to the cent).",
  "assert": {
    "kind": "value",
    "source": {
      "from": "node",
      "field": "text",
      "target": {
        "anchors": [
          { "role": "status", "name": "Cart total" },
          { "role": "status", "landmark": { "role": "region", "name": "Cart summary" } }
        ]
      }
    },
    "normalize": [{ "op": "currency", "locale": "en-US", "currency": "USD" }],
    "expect": { "approx": { "value": { "amount": 21.5, "currency": "USD" }, "abs": 0.005 } }
  }
}
```

Assertion kinds: `state`, `contains` (with an optional `witness`), `value`
(read from `node`, `text`, `url`, `request`/`response`, `storage` or `probe`,
then normalized, then compared), `url`, `request`, and `allOf`/`anyOf`
(Kleene logic). The JSON Schema is exported as `checkSetSchema`, and
`validateCheckSet` adds semantic checks: traceable quotes, requirement
references, regex and schema compilation, and normalizer and comparison
type flow.

## A report

A page that only _claims_ an order was placed (spoofed heading and URL, no
order request):

```
Verdict: FAIL  (tiny-shop/express-order v1, snapshot sha256:2f7375b64494…)
✘ [hard] R1: An order is placed
    ✘ C1: POST /api/orders returned 201 with status 'placed'.
        fail: 0 request(s) match POST, path /api/orders, status 201, response body matching schema (expected at least 1)
? [hard] R2: The order ships express  (value_unavailable)
    ? C2: The placed order's shipping method is express (from the server's response).
        abstain (value_unavailable): no request matches POST, path /api/orders, status 201
✔ [soft] R3: The order confirmation is shown
    ✔ C3: The browser is on an order page, or an 'Order confirmed' heading is shown.
```

## Compiling checks (milestone 2)

```ts
import { anthropicModel, compileTask, loadSnapshot } from 'assay';

const { checkSet, report } = await compileTask(
  { id: 'shop/express-order', instruction, outcomes }, // outcomes: Gherkin "Then" clauses, a Markdown list or plain lines
  [{ name: 'reference', kind: 'success', snapshot: loadSnapshot(json) }],
  { model: await anthropicModel() }, // or any ModelClient
);
```

The compiler writes a rubric of requirements, each quoting the task text. An agent then explores the reference snapshots and submits checks, which are accepted only once they validate and pass on every correct reference. See [ADR 0002](docs/adr/0002-compiler.md). `npm run compile:tiny-shop` compiles the 10 Tiny Shop tasks from one correct run each and judges the held-out runs. It needs `ANTHROPIC_API_KEY` to record and replays the recorded cassettes without one.

## Development

Requires **Node.js 24+** (see `.nvmrc`). Tooling: [tsrs](https://github.com/oxc-project/tsrs)
for typechecking and builds, [oxlint](https://oxc.rs/docs/guide/usage/linter) and
[oxfmt](https://oxc.rs/docs/guide/usage/formatter) for linting and formatting.

```sh
npm install
npx playwright install --with-deps chromium
npm run check        # format:check + lint + typecheck + build + test (what CI runs)
npm test             # unit tests + live tests against the Tiny Shop demo app (auto-started)
npm run format       # oxfmt --write
npm run build        # tsrs -> dist/
npm run shop         # run the demo app on :4173
```

CI (`.github/workflows/ci.yml`) runs format, lint, typecheck and build, then the
full test suite on Node 24 and the latest Node release.

Milestone 1 acceptance lives in `tests/tasks.spec.ts`. It covers 10 tasks
and 20 checks. Each task has a correct run (success), incorrect runs (fail:
wrong item, partial or over-completion, spoofed success) and anchor or
evidence removal (abstain), both on the live page and on edited snapshots.
Every live evaluation is also run on the serialized snapshot, and the test
asserts both give identical results.
