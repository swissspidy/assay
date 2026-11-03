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

The compiler writes a rubric of requirements, each quoting the task text. An agent then explores the reference snapshots and submits checks, which are accepted only once they validate and pass on every correct reference. See [ADR 0002](docs/adr/0002-compiler.md). `npm run compile:examples` compiles the 30 example tasks from one correct run each and judges the held-out runs. It needs `ANTHROPIC_API_KEY` to record and replays the recorded cassettes without one.

## Stress testing (milestone 3)

```ts
import { stressTest, formatStressReport } from 'assay';
const report = stressTest(checkSet, [{ name: 'reference', snapshot }]);
console.log(formatStressReport(report)); // acceptance/rejection rates, over-constrained, fragile and weak checks
```

The stress test edits correct snapshots into valid variants (reordered rows, unrelated content, extra JSON fields, other number, money and date formats, network noise) and into near-miss mutants (flipped states, missing items, perturbed values, failed or missing requests, pages that only claim success). A check that rejects a valid variant is flagged as over-constrained, and the compiler sends that back to the model as an error. See [ADR 0003](docs/adr/0003-stress-testing.md). `npm run stress` writes `examples/<app>/stress/handwritten/REPORT.md` for each app.

## Escalation, records and locking (milestone 4)

```ts
import { anthropicModel, lockCheckSet, reviewSheet, verifyWithEscalation, writeOutcomeRecord } from 'assay';

console.log(reviewSheet(checkSet)); // plain-language review for a human
const locked = lockCheckSet(checkSet, 'reviewer@example.com'); // tamper-evident

const { outcome, record, proposal } = await verifyWithEscalation(locked, snapshot, {
  verifier: await anthropicModel(), // decides only what the checks abstained on
  requireLocked: true,
  agentReport: 'I placed the order.', // recorded as agent-claimed, never evidence
});
writeOutcomeRecord('assay-records', record, snapshot, proposal);
```

In Playwright: `await expectOutcome(page, locked, { escalate: { verifier }, recordDir: 'assay-records' })`. See [ADR 0004](docs/adr/0004-escalation-and-records.md).

## Evaluation and stability (milestone 5)

Three small apps (`examples/tiny-shop`, `examples/tiny-tracker`, `examples/tiny-calendar`) provide 30 tasks and 123 labelled runs (correct, wrong item, partial, undone, over-completion, adversarial pages that only claim success).

- `npm run eval` compares checks, checks with escalation, an LLM judge and the agentic verifier on balanced accuracy, TPR, TNR, cost and latency. Results go to `eval/results/REPORT.md`. Add `-- --checks compiled` to use the compiled check sets.
- `npm run stability` judges every run against the app as recorded and against a redesigned UI. Results go to `stability/results/REPORT.md`.
- A weekly workflow runs both.

Model rows are recorded to cassettes when `ANTHROPIC_API_KEY` is set and replayed otherwise. See [ADR 0005](docs/adr/0005-evaluation-and-stability.md).

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
