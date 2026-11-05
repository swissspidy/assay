# Assay

Compiled outcome verification for web agent tasks.

Did the agent actually do what it was asked? Asking a model to judge every run is slow, costs money
and can be talked into a pass by a page that only claims success. Assay asks a model once, when you
author the task: it compiles the task into checks, which are plain JSON. The checks then run against
an evidence snapshot of the page in milliseconds, with no model. A check returns **pass**, **fail**
or **abstain**. Abstain means it could not find or read its evidence; only then does Assay escalate
to an agentic verifier.

## Install

```sh
npm install -D @swissspidy/assay @playwright/test
```

Requires Node.js 24 or later. Models are only needed to compile checks and to escalate; for those,
also install [`@anthropic-ai/sdk`](#model-providers) or the [Vercel AI SDK](#model-providers).
Releases: [CHANGELOG.md](CHANGELOG.md).

## Quick start

In a Playwright test:

```ts
import { readFileSync } from 'node:fs';
import { test, expectOutcome } from '@swissspidy/assay/playwright';

const checks = JSON.parse(readFileSync('checks/express-order.checks.json', 'utf8'));

test('agent ordered with express shipping', async ({ page }) => {
  await runMyAgent(page, 'Order what is in my cart with express shipping.');
  // The `test` fixture records the network from the start of the test. expectOutcome captures a
  // snapshot and runs the checks, polling until the expected verdict (success) or the timeout.
  await expectOutcome(page, checks, {
    probes: { latestOrder: () => page.request.get('/api/orders/latest').then((r) => r.json()) },
  });
});
```

Offline, against a stored snapshot:

```ts
import { readFileSync } from 'node:fs';
import { formatOutcome, loadSnapshot, verify } from '@swissspidy/assay';

const checks = JSON.parse(readFileSync('checks/express-order.checks.json', 'utf8'));
const { outcome } = await verify(checks, loadSnapshot(readFileSync('snapshot.json', 'utf8')));
console.log(formatOutcome(outcome));
```

When a check compares the end state with the start ("keep everything else", "order what is in my
cart"), capture a baseline after setting up the starting state and before the agent acts. Later
snapshots in the same browser context include it:

```ts
import { captureBaseline } from '@swissspidy/assay/playwright';

await captureBaseline(page, { probes }); // probe results and storage before the task
await runMyAgent(page, 'Remove the Red Mug from my cart, but keep everything else.');
await expectOutcome(page, checks, { probes });
```

`verify` validates the check set first and throws `CheckSetError` if it is invalid. `evaluate` is
the same check run without validation or a record, for hot loops.

## Concepts

- **Evidence snapshot.** What a run left behind: the accessibility tree, visible text, URL, network
  log, storage and the results of backend probes you define. Captured with `captureSnapshot` (or by
  `expectOutcome`), stored as JSON, and evaluated the same way live or offline.
- **Requirements and checks.** A check set lists requirements, each quoting the task text it comes
  from, and checks, each tracing to one requirement:

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
        "target": { "anchors": [{ "role": "status", "name": "Cart total" }] }
      },
      "normalize": [{ "op": "currency", "locale": "en-US", "currency": "USD" }],
      "expect": { "approx": { "value": { "amount": 21.5, "currency": "USD" }, "abs": 0.005 } }
    }
  }
  ```

  Assertion kinds: `state`, `contains`, `value` (read from a node, text, the URL, a request or
  response, storage or a probe, then normalized and compared with a literal, or with a second
  source via `sameAs`), `url`, `request`, `each` and `allOf`/`anyOf`. Normalizers parse numbers,
  money, dates and date-times (`datetime`, compared as instants; `approx` on them is in minutes).
  The JSON Schema is exported as `checkSetSchema`; `validateCheckSet` adds semantic checks.

- **Records.** `each` checks a value inside the record it belongs to, not anywhere on the page.
  Every node matching `match` is a record (a row, a list item; a term with the definitions after
  it), and `assert` must hold inside each one, with its locators resolved within the record:

  ```json
  {
    "kind": "each",
    "scope": { "role": "table", "name": "Issues" },
    "match": { "role": "row", "name": { "contains": "Login button misaligned" } },
    "assert": { "kind": "contains", "match": { "role": "cell", "name": "Open" } }
  }
  ```

  A cell can be bound to its column header (`{"role": "cell", "name": "Open", "column": "Status"}`),
  so another cell of the row that reads the same text does not match. The number of records is
  outcome evidence (default at least one, else fail); a label the page
  always shows (a term "When") belongs in `witness` too, so renamed copy abstains
  ([ADR 0008](docs/adr/0008-per-record-checks.md)).

- **Baseline.** A probe or storage source with `"at": "before"` reads the state before the task
  (`captureBaseline`); without a baseline such a check abstains. The `items` normalizer turns a JSON
  array into an unordered collection (filtered by a JSON Schema `where`, projected to one field by a
  `pointer` or, when the two sides' items have different fields, to the fields both have, kept
  together, by `pick: ["/sku", "/qty"]`), so
  "keep everything else" is the cart after `sameAs` the cart before, minus the removed item:

  ```json
  {
    "kind": "value",
    "source": { "from": "probe", "probe": "cart", "pointer": "/items" },
    "normalize": [{ "op": "items" }],
    "expect": {
      "sameAs": {
        "source": { "from": "probe", "probe": "cart", "pointer": "/items", "at": "before" },
        "normalize": [{ "op": "items", "where": { "not": { "properties": { "name": { "const": "Red Mug" } } } } }]
      }
    }
  }
  ```

- **Pass, fail, abstain.** Checks combine with three-valued logic. A requirement passes when its
  checks pass; the run succeeds when every hard requirement passes. Abstain is never turned into a
  pass or a fail silently.
- **Escalation.** Requirements the checks abstained on can go to an agentic verifier, which explores
  the snapshot (and, live, the page) with read-only tools and must cite what it observed.

A report for a page that only _claims_ an order was placed:

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

Design details: [ADR 0001](docs/adr/0001-evidence-snapshot-and-check-dsl.md).

## Authoring checks

1. **Compile** the task and one or more reference runs into a check set:

   ```ts
   import { compileTask } from '@swissspidy/assay/compiler';
   import { anthropicModel } from '@swissspidy/assay/models';

   const { checkSet, report } = await compileTask(
     { id: 'shop/express-order', instruction, outcomes }, // outcomes: Gherkin "Then" steps, a Markdown list or plain lines
     [{ name: 'reference', kind: 'success', snapshot }],
     { model: await anthropicModel() },
   );
   ```

   A model writes the requirements, each quoting the task. An agent then explores the reference
   snapshots and submits checks; a submission is accepted only once it validates, succeeds on every
   correct reference, does not succeed on any negative one, and accepts the stress test's valid
   variants ([ADR 0002](docs/adr/0002-compiler.md)).

2. **Stress-test** a check set against edited copies of correct runs: valid variants (reordered rows,
   other number and date formats, extra fields, network noise) that must still pass, and near-miss
   mutants (wrong item, missing request, pages that only claim success) that must not
   ([ADR 0003](docs/adr/0003-stress-testing.md)):

   ```ts
   import { formatStressReport, stressTest } from '@swissspidy/assay/stress';

   console.log(formatStressReport(stressTest(checkSet, [{ name: 'reference', snapshot }])));
   ```

3. **Review and lock.** `reviewSheet` renders each check in plain language next to what it actually
   tests. `lockCheckSet` records who confirmed it; any later edit breaks the lock:

   ```ts
   import { lockCheckSet, reviewSheet } from '@swissspidy/assay';

   console.log(reviewSheet(checkSet));
   const locked = lockCheckSet(checkSet, 'reviewer@example.com');
   ```

## Escalation and records

```ts
import { verify } from '@swissspidy/assay';
import { anthropicModel } from '@swissspidy/assay/models';

const { outcome, record, written } = await verify(locked, snapshot, {
  verifier: await anthropicModel(), // decides only what the checks abstained on
  requireLocked: true,
  agentReport: 'I placed the order.', // recorded as agent-claimed, never evidence
  recordDir: 'assay-records',
});
```

By default only abstained hard requirements escalate; `policy: { on: ['abstain', 'fail'] }` also
sends failures. A check known to be brittle can set `"onFail": "escalate"`, and a robust one
`"onFail": "keep"`: a failed requirement escalates only when every check that failed it allows it.

The verifier sees only the escalated requirements, gets read-only tools, and must cite the tool
outputs it relies on; uncited verdicts are rejected. Its decisions are merged into the outcome and
marked `decidedBy: "verifier"`. The outcome record (`assay.record/v1`) keeps who decided each
requirement and on what evidence, the agent's claims labelled as claims, the verifier's
observations, and content-addressed copies of the snapshot and check set. With a `proposer` model,
a run the verifier rescued yields a recompiled check set, recorded as pending approval.

In Playwright, `expectOutcome` and `verifyPage` take the same options, and the verifier also gets
read-only live access to the page:

```ts
await expectOutcome(page, locked, { verifier, recordDir: 'assay-records' });
```

`writeOutcomeRecord(dir, result)` writes a `verify` result's record by hand. Details:
[ADR 0004](docs/adr/0004-escalation-and-records.md).

## Command line

The package installs an `assay` executable (`npx assay <command> --help` for every option):

```sh
assay compile "Add a Blue Mug to my cart." --outcomes "Then the cart contains a Blue Mug" \
  --reference runs/added-blue-mug.json --out checks/add-blue-mug.checks.json
assay validate checks/*.checks.json          # schema, semantic errors, loose-match warnings, lock
assay review checks/add-blue-mug.checks.json # the review sheet: every check in plain language
assay stress checks/add-blue-mug.checks.json --reference runs/
assay verify checks/add-blue-mug.checks.json snapshot.json --record assay-records
assay capture http://localhost:4173/cart --out runs/
```

- **`compile <task>`**: the task is the instruction text, a text file, or a JSON file with
  `{ "id", "instruction", "outcomes", "skipVariants" }` (or a check set, whose task is recompiled).
  `--reference` (repeatable) is a snapshot file or a directory of them; `--negative` adds incorrect
  runs. A refused compile prints its reason and warnings.
- **`verify <checks> <snapshot>`** prints each requirement and check with its evidence.
  `--escalate` sends abstained requirements to the agentic verifier, `--record <dir>` writes the
  outcome record, `--require-locked` refuses an unlocked set.
- **`stress <checks> --reference <path>`** reports over-constrained, fragile and weak checks and
  missed mutants. **`validate <checks...>`** (`--strict` fails on warnings) and **`review <checks>`**
  need no snapshot.
- **`capture <url>`** opens the URL in headless Chromium and writes a snapshot (needs
  `@playwright/test` and `npx playwright install chromium`). It sees what loading the page shows; for
  probes, a baseline or a task run first, capture from a Playwright test.

A snapshot file is a snapshot, or a labelled run `{ "label": { "expected": "fail" }, "snapshot" }`
as in `examples/*/references` (`compile` treats it as a negative, `stress` skips it).

| Exit status | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| 0           | success; valid; no stress problems; compiled                                  |
| 1           | verdict fail; invalid check set; stress problems; compile refused             |
| 2           | verdict abstain (inconclusive)                                                |
| 3           | usage error (unknown command or option, missing argument)                     |
| 4           | other error (unreadable or invalid input, missing dependency or key, a model) |

Output is for people by default and JSON with `--json`; colour only on a terminal (`NO_COLOR`,
`--no-color`). Models, for `compile` and `verify --escalate`:

| Option / variable              | Effect                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--provider`, `ASSAY_PROVIDER` | `anthropic` (default; `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`) or `ai-sdk` (`ai`; the model id goes to the AI SDK's default provider, the AI Gateway unless configured) |
| `--model`, `ASSAY_MODEL`       | Model id (Anthropic default `claude-opus-5-5`)                                                                                                                           |
| `--cassette <file>`            | Replay the cassette if it exists, else record the live run to it                                                                                                         |
| `ASSAY_MODEL_MODE`             | `replay`: never call a model (needs `--cassette`); `record`: re-record the cassette                                                                                      |

Design: [ADR 0010](docs/adr/0010-command-line-tool.md).

## Model providers

Any object with an `id` and a `turn(request)` method is a `ModelClient`. Two adapters come with the
package:

- **Anthropic** (`@swissspidy/assay/models`, needs `@anthropic-ai/sdk`): `await anthropicModel()`
  streams requests with an explicit effort, prompt caching and server-side refusal fallbacks. It is
  what the measured numbers below use.
- **Vercel AI SDK** (`@swissspidy/assay/ai-sdk`, needs `ai` 7 or later and a provider package):
  `aiSdkModel` wraps any AI SDK language model. Each turn is one `generateText` call whose tools
  have no `execute`, so Assay's own loop still validates inputs, enforces citations and records
  cassettes ([ADR 0007](docs/adr/0007-vercel-ai-sdk-adapter.md)). The AI SDK's type declarations
  import `json-schema`, so TypeScript projects need `skipLibCheck` or `@types/json-schema`.

  ```ts
  import { anthropic } from '@ai-sdk/anthropic'; // or any other AI SDK provider
  import { aiSdkModel } from '@swissspidy/assay/ai-sdk';

  const verifier = aiSdkModel(anthropic(process.env.ASSAY_MODEL!), { maxOutputTokens: 32000 });
  ```

**Cassettes** make model steps reproducible. `recordingModel(model, path)` records every turn under
a digest of the full request; `replayModel(path)` replays them without a key and fails loudly if a
request changed. Both are in `@swissspidy/assay/models`.

## How well it works

Three small example apps (`examples/tiny-shop`, `tiny-tracker`, `tiny-calendar`) provide 30 tasks
and 126 labelled runs: correct, wrong item, partial, undone, over-completion, and adversarial pages
that only claim success. Each task was compiled from one correct run; on the 96 held-out runs:

| System           | Balanced accuracy | TPR   | TNR   | Cost / run | Latency (median / p95) | Model at run time |
| ---------------- | ----------------- | ----- | ----- | ---------- | ---------------------- | ----------------- |
| compiled checks  | 1.000             | 1.000 | 1.000 | $0         | 0.3 ms / 4.7 ms        | no                |
| LLM judge        | 0.906             | 0.933 | 0.879 | $0.0119    | 4.3 s / 10.0 s         | yes               |
| agentic verifier | 0.976             | 0.967 | 0.985 | $0.0275    | 9.6 s / 12.3 s         | yes               |

The LLM judge accepted 3 of 8 adversarial pages, and all 3 runs that changed the starting cart
wrongly; the checks and the verifier rejected all of them.
Full results: [eval/results/compiled/REPORT.md](eval/results/compiled/REPORT.md). Against simulated
later releases of each app (renamed copy, new layout, extra API fields, a real regression), checks
written for the first release give no wrong verdict: they abstain where renamed text breaks an
anchor, and catch every regression run ([stability report](stability/results/REPORT.md),
[ADR 0005](docs/adr/0005-evaluation-and-stability.md)).

On three real open-source apps run locally (Gitea, WordPress, PrestaShop: 44 tasks, 177 held-out
runs, mostly from a Claude browser agent, labelled by oracles over each app's database), compiled
checks reach 0.974 balanced accuracy (0.986 with escalation), against 0.942 for the LLM judge and
0.990 for the agentic verifier. Four of the checks' five errors are checks tied to the one reference
run's UI path where a probe lacked a field; the fifth accepted a run that removed a tag it was not
asked to remove.
[eval/results/real/REPORT.md](eval/results/real/REPORT.md), [ADR 0009](docs/adr/0009-real-site-evaluation.md).

## Further reading

- [ADR 0001](docs/adr/0001-evidence-snapshot-and-check-dsl.md): snapshot format and check DSL
- [ADR 0002](docs/adr/0002-compiler.md): compiler, agent loop and cassettes
- [ADR 0003](docs/adr/0003-stress-testing.md): stress testing
- [ADR 0004](docs/adr/0004-escalation-and-records.md): escalation, records and locking
- [ADR 0005](docs/adr/0005-evaluation-and-stability.md): evaluation and stability
- [ADR 0006](docs/adr/0006-npm-package-and-releases.md): the npm package and releases
- [ADR 0007](docs/adr/0007-vercel-ai-sdk-adapter.md): the Vercel AI SDK adapter
- [ADR 0008](docs/adr/0008-per-record-checks.md): per-record checks and paired item fields
- [ADR 0009](docs/adr/0009-real-site-evaluation.md): evaluation on real web apps
- [ADR 0010](docs/adr/0010-command-line-tool.md): the `assay` command-line tool
- Example check sets: [handwritten](examples/tiny-shop/tasks) and [compiled](examples/tiny-shop/compiled)
- Development and releases: [CONTRIBUTING.md](CONTRIBUTING.md)

## License

Copyright 2026 Pascal Birchler. Licensed under the [Apache License, Version 2.0](LICENSE).
