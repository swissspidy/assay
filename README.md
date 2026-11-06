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

Requires Node.js 24 or later. Models are only needed to compile checks and to escalate; any model
works ([Configure a model](#configure-a-model)). Releases: [CHANGELOG.md](CHANGELOG.md).

## Configure a model

`npx assay init` writes `assay.config.ts`. `model` takes any of three forms:

```ts
import { defineConfig } from '@swissspidy/assay';
import { openai } from '@ai-sdk/openai';

export default defineConfig({
  model: 'anthropic:claude-opus-5-5', // 1. "provider:model" (npm i -D ai @ai-sdk/anthropic)
  // model: openai('gpt-5'),         // 2. any Vercel AI SDK model
  // model: { id: 'my-llm', async turn(request) { /* … */ } }, // 3. your own adapter, no AI SDK
  checks: 'checks', // assay validate with no files checks these
  recordDir: 'assay-records',
});
```

Strings name the provider's AI SDK package (`openai:…` → `@ai-sdk/openai`, `ollama:…` →
`ollama-ai-provider-v2`, `google`, `mistral`, `groq`, `bedrock`, …); a missing one is reported by
name. Models without tool calling are driven in JSON mode: the tools go into the prompt, each reply
is validated against the tool's schema with one repair retry, and records and reports say
`modes: ["json"]`. AI SDK models fall back by themselves when the provider reports no tool support;
an adapter declares `capabilities: { tools: false }`; `modelOptions: { mode: 'json' }` forces it.

The CLI and the library (`compileTask`, `verify`, `expectOutcome`) read the config from the current
directory (`--config <file>` / `config` option for another, `config: false` for none). Commands
that need no model never load it. Precedence: **flags, then environment variables
(`ASSAY_MODEL`, …), then the config, then defaults**; in code, explicit options win over the
config ([ADR 0017](docs/adr/0017-config-file-and-bring-your-own-model.md)).

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

To verify many runs of one task (an evaluation, a nightly batch), `verifyMany` returns what
`verify` returns for each snapshot, in order, and runs each check across all of them in turn:

```ts
import { verifyMany } from '@swissspidy/assay';

const results = await verifyMany(checks, snapshots, { recordDir: 'assay-records' });
const failed = results.filter((r) => r.outcome.verdict !== 'success');
```

Both index a snapshot and prepare a check set once per object and reuse that on later calls, so a
repeated `verify` costs tens of microseconds
([ADR 0015](docs/adr/0015-evidence-store-and-compiled-checks.md)). Do not edit a snapshot or check
set after verifying it; edit a copy.

## Concepts

- **Evidence snapshot.** What a run left behind: the accessibility tree, visible text, URL, network
  log, storage and the results of backend probes you define. Captured with `captureSnapshot` (or by
  `expectOutcome`), stored as JSON, and evaluated the same way live or offline. Iframe content
  (same- and cross-origin) sits under its `iframe` node, where locators find it like any other node
  (scope to `{"role": "iframe", "name": "Editor canvas"}` to stay in one frame); open shadow roots
  are included, closed ones are not. Other open tabs and popups are kept as `pages`; the snapshot's
  page is the active one. Form request bodies, URL-encoded and multipart, are parsed into fields,
  with uploads recorded as `{filename, type, size}` ([ADR 0012](docs/adr/0012-snapshot-frames-pages-bodies.md)).
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
  source via `sameAs`), `url`, `request`, `each`, `page` (another open tab or popup, selected by
  URL or title) and `allOf`/`anyOf`. Normalizers parse numbers,
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

  For one record's own collection (a post's tags), `{"op": "items", "where": …, "pointer": "/tags", "flatten": true}`
  makes the array's members the items, so "add the tag X" can also check that the other tags stay.

- **Route evidence.** Requests, responses and the page URL show how one run did the task (Quick Edit
  or the block editor, the admin list or the public form), not the state it left. A check that
  reads them can set `"onMissing": "abstain"`: when none of its requests match (or the URL is
  elsewhere) it abstains with `route_missing` and escalates, instead of failing a run that took
  another route. Evidence that is found but wrong still fails, and inside an `anyOf` the branch of
  the route the run took decides ([ADR 0011](docs/adr/0011-route-robust-compilation.md)).

- **Tolerance.** Where a correct run gives two sources slightly different values (a total the page
  rounds to the cent, a time shown to the minute and stored to the second), a `sameAs` binding can
  take an explicit, bounded tolerance with its reason, which the review sheet shows:
  `"tolerance": { "abs": 1, "because": "the page shows the time to the minute" }` (minutes for
  date-times, days for dates; `rel` for numbers and money, at most 5%). The stress test rejects
  values just past it and accepts values inside it
  ([ADR 0014](docs/adr/0014-sameas-tolerance-and-nested-mutants.md)).
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

   const { checkSet, report } = await compileTask(
     { id: 'shop/express-order', instruction, outcomes }, // outcomes: Gherkin "Then" steps, a Markdown list or plain lines
     [{ name: 'reference', kind: 'success', snapshot }],
     { model: 'anthropic:claude-opus-5-5' }, // or leave it out to use assay.config.ts
   );
   ```

   A model writes the requirements, each quoting the task. An agent then explores the reference
   snapshots and submits checks; a submission is accepted only once it validates, succeeds on every
   correct reference, does not succeed on any negative one, and accepts the stress test's valid
   variants ([ADR 0002](docs/adr/0002-compiler.md)).

   Correct references that did the task in different ways (give each a `note`, e.g.
   `"through the block editor"`) make the checks route-robust: route evidence one of them lacks
   must be marked `onMissing: "abstain"`. The report flags requirements whose only evidence is
   route evidence (`coverage[].routeOnly`), naming the probes that could carry it, and the compiler
   refuses them when a probe already holds the value they compare
   ([ADR 0011](docs/adr/0011-route-robust-compilation.md)).

2. **Stress-test** a check set against edited copies of correct runs: valid variants (reordered rows
   and nested arrays, other number and date formats, extra fields, network noise) that must still
   pass, and near-miss mutants (wrong item, an option dropped from an order line, missing request,
   pages that only claim success) that must not
   ([ADR 0003](docs/adr/0003-stress-testing.md), [ADR 0014](docs/adr/0014-sameas-tolerance-and-nested-mutants.md)):

   ```ts
   import { formatStressReport, stressTest } from '@swissspidy/assay/stress';

   console.log(formatStressReport(stressTest(checkSet, [{ name: 'reference', snapshot }])));
   ```

3. **Review and approve.** `reviewSheet` renders each check in plain language next to what it
   actually tests and the evidence it reads, with warnings and stress findings. Approving locks the
   set; any later edit breaks the lock (see [Review and signed locks](#review-and-signed-locks)):

   ```ts
   import { approveCheckSet, reviewSheet } from '@swissspidy/assay';
   import { stressTest } from '@swissspidy/assay/stress';

   const stress = stressTest(checkSet, [{ name: 'reference', snapshot }]);
   console.log(reviewSheet(checkSet, { stress }));
   const locked = approveCheckSet(checkSet, { by: 'reviewer@example.com', key: privateKeyPem });
   ```

## Review and signed locks

A compiled check set is a **proposal** until a reviewer approves it, which locks it, or rejects it
with a note. The lock records the reviewer, the time, a digest of the set and of each requirement and
check, the stress report they saw, and optionally an Ed25519 signature. `verify` can require a lock
signed by a key you trust; an edit after approval breaks the lock and the refusal names what changed
("changed after approval: check C2 changed"). Locks made before signing existed still verify.

```sh
assay keygen --out ~/.assay/alice.pem                      # alice.pem (secret) and alice.pub.pem
assay review checks/order.checks.json --diff old.checks.json --format github  # only what changed
assay approve checks/order.checks.json --reviewer alice --key ~/.assay/alice.pem --note "R2 checked"
assay reject checks/order.checks.json --reviewer bob --note "C3 reads free text"
assay verify checks/order.checks.json snapshot.json --require-signed --trusted-key keys/
assay validate checks/*.checks.json --require-signed --trusted-key keys/  # CI gate: exit 1 if not approved
```

```ts
await verify(checkSet, snapshot, { requireLocked: { trustedKeys: [alicePublicKeyPem] } });
```

A recompiled set is re-reviewed against the approved version: the diff lists requirements and
checks added, removed and changed in plain language, and which requirements to read again. Approval
is not carried over for unchanged parts: a lock covers the whole set, so the reviewer approves it
again. Keys come from files or `ASSAY_SIGNING_KEY` / `ASSAY_TRUSTED_KEYS` (PEM text). Design, and an
example GitHub workflow that posts the review sheet on pull requests:
[ADR 0013](docs/adr/0013-review-workflow-and-signed-locks.md).

## Escalation and records

```ts
import { verify } from '@swissspidy/assay';

const { outcome, record, written } = await verify(locked, snapshot, {
  verifier: 'anthropic:claude-opus-5-5', // decides only what the checks abstained on (or escalate: true in the config)
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
assay init                                   # assay.config.ts: the model and project defaults
assay compile "Add a Blue Mug to my cart." --outcomes "Then the cart contains a Blue Mug" \
  --reference runs/added-blue-mug.json --out checks/add-blue-mug.checks.json
assay validate checks/*.checks.json          # schema, semantic errors, loose-match warnings, lock
assay review checks/add-blue-mug.checks.json # the review sheet: every check in plain language
assay approve checks/add-blue-mug.checks.json --reviewer alice --key alice.pem
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
  outcome record, `--require-locked` refuses a set that is not approved, `--require-signed` one
  not signed by a `--trusted-key`.
- **`stress <checks> --reference <path>`** reports over-constrained, fragile and weak checks and
  missed mutants. **`validate <checks...>`** (`--strict` fails on warnings) and **`review <checks>`**
  (`--diff <old>`, `--format github|html`) need no snapshot.
- **`approve`**, **`reject`**, **`unlock`** and **`keygen`**: the
  [review workflow](#review-and-signed-locks).
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
`--no-color`). Every command reads `assay.config.ts` (or `--config <file>`). Models, for `compile`
and `verify --escalate`, override the config's `model`:

| Option / variable              | Effect                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--model`, `ASSAY_MODEL`       | `provider:model` (as in the config), or a model id for `--provider`. Without any model setting, `claude-opus-5-5` when `ANTHROPIC_API_KEY` is set                                 |
| `--provider`, `ASSAY_PROVIDER` | For a bare id: `anthropic` (default; `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`) or `ai-sdk` (`ai`; the id goes to the AI SDK's default provider, the AI Gateway unless configured) |
| `--cassette <file>`            | Replay the cassette if it exists, else record the live run to it                                                                                                                  |
| `ASSAY_MODEL_MODE`             | `replay`: never call a model (needs `--cassette`); `record`: re-record the cassette                                                                                               |

Design: [ADR 0010](docs/adr/0010-command-line-tool.md).

## Model providers

Any object with an `id` and a `turn(request)` method is a `ModelClient`; `resolveModel` turns any of
the [three config forms](#configure-a-model) into one, and `jsonModeModel` drives one without tool
calling. Two adapters come with the package:

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
a digest of the full request, the model id and the mode (native tools or JSON); `replayModel(path)` replays them without a key and fails loudly if a
request changed. Both are in `@swissspidy/assay/models`. The repository's scripts replay what a
cassette has and, with a key, record only the turns it lacks.

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
checks judge every held-out run correctly (1.000 balanced accuracy, no abstains), against 0.942 for
the LLM judge and 0.990 for the agentic verifier. The first measurement (0.974) lost five runs to
checks tied to one reference's UI route and to "add a tag" read as "replace the tags"; second
references, route evidence that abstains when missing, and "add" keeping what is there fixed all
five ([ADR 0011](docs/adr/0011-route-robust-compilation.md)).
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
- [ADR 0011](docs/adr/0011-route-robust-compilation.md): route-robust compilation (several references, `onMissing`, "add" keeps)
- [ADR 0012](docs/adr/0012-snapshot-frames-pages-bodies.md): frames, open pages and form bodies in snapshots
- [ADR 0013](docs/adr/0013-review-workflow-and-signed-locks.md): the review workflow and signed locks
- [ADR 0014](docs/adr/0014-sameas-tolerance-and-nested-mutants.md): `sameAs` tolerance and nested JSON array mutants
- [ADR 0015](docs/adr/0015-evidence-store-and-compiled-checks.md): the evidence store, compiled check plans and `verifyMany`
- [ADR 0016](docs/adr/0016-overlay-stress-and-capture-digests.md): overlay stress testing and capture-time digests
- [ADR 0017](docs/adr/0017-config-file-and-bring-your-own-model.md): `assay.config.ts`, bring your own model, JSON mode
- Example check sets: [handwritten](examples/tiny-shop/tasks) and [compiled](examples/tiny-shop/compiled)
- Development and releases: [CONTRIBUTING.md](CONTRIBUTING.md)

## License

Copyright 2026 Pascal Birchler. Licensed under the [Apache License, Version 2.0](LICENSE).
