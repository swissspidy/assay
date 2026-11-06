# @swissspidy/assay

## 0.2.0

### Minor Changes

- [#16](https://github.com/swissspidy/assay/pull/16) [`e3c01b4`](https://github.com/swissspidy/assay/commit/e3c01b4b37b2404ff86541f1b391e8501dce6c89) Thanks [@swissspidy](https://github.com/swissspidy)! - `aiSdkModel(model, options)` in `@swissspidy/assay/ai-sdk` runs the compiler and the agentic verifier on any Vercel AI SDK language model (`ai` 7 or later, an optional peer dependency). Assay's own tool loop keeps validating tool inputs, enforcing citations and recording cassettes; the AI SDK only makes each model call.

  ```ts
  import { anthropic } from '@ai-sdk/anthropic'; // or any other AI SDK provider
  import { aiSdkModel } from '@swissspidy/assay/ai-sdk';

  const verifier = aiSdkModel(anthropic(process.env.ASSAY_MODEL!));
  ```

- [#17](https://github.com/swissspidy/assay/pull/17) [`2901795`](https://github.com/swissspidy/assay/commit/2901795910bc1c5c8b5b7f62ed15e3d4629b68f0) Thanks [@swissspidy](https://github.com/swissspidy)! - Checks can compare the end state with the state before the task. `captureBaseline(page, { probes })` (from `@swissspidy/assay/playwright`) captures probe results, storage and the URL before the agent acts; later snapshots in the same browser context carry it as an optional `baseline` (or pass `baseline` to `captureSnapshot`, `verifyPage` and `expectOutcome`; `null` leaves it out). A probe or storage source reads it with `"at": "before"`, and a check that reads a missing baseline abstains. The new `items` normalizer treats a JSON array as an unordered collection (filter by JSON Schema, project by pointer), so "keep everything else" is the cart after `sameAs` the cart before minus one item. Snapshots stay `assay.snapshot/v1`; digests of snapshots without a baseline are unchanged, and `loadSnapshot` validates the baseline when present. Stress testing mutates the baseline side, JSON arrays (an item removed, changed or added) and adds a "nothing changed" mutant.

  A check can set `"onFail": "escalate"` or `"keep"` to override `verify`'s `policy.on` for failures it causes: a failed requirement escalates when every check that failed it allows it. Outcome records show each check's setting and why a requirement was escalated or kept.

- [#29](https://github.com/swissspidy/assay/pull/29) [`b45e502`](https://github.com/swissspidy/assay/commit/b45e50282f9966e4f111a8d443ccdab00b99d1d9) Thanks [@swissspidy](https://github.com/swissspidy)! - Bring your own model, configured once in `assay.config.ts` (`npx assay init` writes one). `model` takes a `'provider:model'` string (resolved through the provider's AI SDK package, with an error naming the package to install), any Vercel AI SDK model, or your own `{ id, turn(request) }` adapter. Models without tool calling are driven in JSON mode, with schema validation and one repair retry; AI SDK models fall back to it when the provider reports no tool support, and records and reports say `modes: ["json"]`. The CLI and the Playwright helpers `expectOutcome` / `verifyPage` read the config (`checks`, `snapshots`, `recordDir`, `escalate`, `requireLocked`, `trustedKeys`, `stress`) from the project directory; `compileTask`, `verify` and `verifyMany` stay pure and use a config only when passed one (`config: (await loadConfig()).config` or a path). Flags win over environment variables, which win over the config. Commands that need no model never load one. Existing cassettes replay unchanged.

  ```ts
  import { defineConfig } from '@swissspidy/assay';

  export default defineConfig({ model: 'anthropic:claude-opus-5-5', checks: 'checks' });
  ```

- [#21](https://github.com/swissspidy/assay/pull/21) [`cdabc83`](https://github.com/swissspidy/assay/commit/cdabc834c469ada2631a148cc2208a093610a6f4) Thanks [@swissspidy](https://github.com/swissspidy)! - The package installs an `assay` command: `assay compile`, `verify`, `stress`, `validate`, `review` and `capture` run the main workflows without writing code. `assay verify` exits 0 on success, 1 on fail and 2 on abstain, so CI can tell a failed run from an inconclusive one (3 is a usage error, 4 any other error); `--escalate` sends abstained requirements to the agentic verifier and `--record <dir>` writes the outcome record. Output is human-readable by default and JSON with `--json`. Models are chosen with `--provider` (`anthropic` or `ai-sdk`), `--model` and `--cassette`, or `ASSAY_PROVIDER`, `ASSAY_MODEL` and `ASSAY_MODEL_MODE`.

  ```sh
  assay verify checks/add-blue-mug.checks.json snapshot.json --record assay-records
  ```

- [#13](https://github.com/swissspidy/assay/pull/13) [`b4de209`](https://github.com/swissspidy/assay/commit/b4de2097f9f400774abf8ccc3fb0f5937f49cd5d) Thanks [@swissspidy](https://github.com/swissspidy)! - Compiled check sets now record their provenance in an optional `compiled` field: the compiler version, the model client, the models that served the turns and when the model ran (`CompileOptions.provenance` overrides the model and time). Cassettes record when they were recorded, and `replayModel` and `recordingModel` expose it as `recorded`, so a replayed compile reproduces the original file.

- [#15](https://github.com/swissspidy/assay/pull/15) [`a64ec56`](https://github.com/swissspidy/assay/commit/a64ec56966b5596bb64ebd99dbbf80dc4e14ec8f) Thanks [@swissspidy](https://github.com/swissspidy)! - Two additions to the check DSL. A `sameAs` comparison binds a value to a value read from a second source, each normalized by its own pipeline: for example, the order number on the confirmation page must equal the `latestOrder` probe's `/id`. Either side unreadable abstains; both read and different fails. A `datetime` normalizer parses date-times to an instant in UTC (the value's own offset, or the wall clock in `timezone`; ambiguous values abstain), and `approx` on datetimes takes a tolerance in minutes. Stress testing perturbs either side of a binding, shifts datetimes past their tolerance and re-renders them in other localized formats.

- [#27](https://github.com/swissspidy/assay/pull/27) [`1f8fecc`](https://github.com/swissspidy/assay/commit/1f8feccd15f003fa074e664822f5a7188d8d5ab0) Thanks [@swissspidy](https://github.com/swissspidy)! - Deterministic verification is about 35 times faster when a snapshot and check set are verified more than once. Each snapshot is indexed once into an evidence store: the accessibility tree as columns with lookups by role and name, the network log as a table with URLs parsed once, and its digest computed once. Each check set is compiled once into a plan: validated, digested and with every check prepared. Both are cached per object, so a repeated `verify` takes tens of microseconds instead of about 1.3 ms. A first `verify` is now mostly the snapshot digest. Verdicts, messages, evidence and records are unchanged. New `verifyMany(checkSet, snapshots, options)` returns what `verify` returns for each snapshot, in order, running each check across all of them in turn. A snapshot or check set must not be edited after it has been verified; edit a copy.

- [#18](https://github.com/swissspidy/assay/pull/18) [`a6556f8`](https://github.com/swissspidy/assay/commit/a6556f8a3b18c431f619dcc91c1dbb103b6ddc3e) Thanks [@swissspidy](https://github.com/swissspidy)! - `validateCheckSet` warns about comparisons that accept more than they appear to: an unanchored `regex` with no regex syntax on structured evidence (probe, storage, request or response, URL parts, a URL match's regex or query parameters), which also matches longer values (`/Berlin/` accepts `Europe/Berlin-Test`), a JSON Schema property pinned with `const` or `enum` (also in a combinator branch or through a local `$ref`) that is not in `required`, so a value without it passes, and two or more `sameAs` checks in one requirement comparing the same collections through `items` with different pointers, which pair the fields of different records. The compiler refuses all three, as well as a check that abstains on a valid stress variant of a correct reference (previously a warning), and its discovery prompt asks for exact comparisons of exact values and for a page identity check (URL path, or a heading or landmark) when a requirement names a page, with a record's title compared exactly, and for collections compared as whole records.

- [#32](https://github.com/swissspidy/assay/pull/32) [`0886145`](https://github.com/swissspidy/assay/commit/0886145b9c31392640559e6d92d18110c425880c) Thanks [@swissspidy](https://github.com/swissspidy)! - Mining-first compiler: `compileTask(task, refs, { discovery: 'mine-first' })` (`assay compile --mine-first`, or `compile: { discovery }` in `assay.config.ts`) mines candidate checks from the reference runs without a model, evaluates them in one batch over the references, the baseline and the stress variants, and accepts them through the same gate as the discovery agent. Requirements mining settles cost no discovery turn; the agent gets only the open ones, seeded with the mined candidates (a new `mined_candidates` tool). `discovery: 'mine-only'` (`--mine-only`) never asks for checks and, with `rubric: 'deterministic'`, needs no model; it fails with a reason per requirement it cannot cover. A mined set records `compiled.discovery` (`'mined'` or `'mined+model'`) and the report a `mining` section. The default stays `'model'`, so existing compiles and cassettes replay unchanged.

- [#30](https://github.com/swissspidy/assay/pull/30) [`df91d81`](https://github.com/swissspidy/assay/commit/df91d813cebe73c5161e948a5082eef625c948a2) Thanks [@swissspidy](https://github.com/swissspidy)! - `assay bench` compares models on your own tasks: it compiles each task with each model (`--model`, repeatable: a `'provider:model'` string or a module exporting a model or adapter; or `bench.models` in `assay.config.ts`), stress-tests the check sets and scores them on the task's held-out labelled runs. One row per model: tasks compiled, check sets with no stress problems, balanced accuracy and false successes, and turns, tokens, cost and time per task, with the best value per column marked. `--runs N` gives mean and spread, `--task <glob>` filters, `--escalate` also tries each model as the verifier, `--json` and `--out report.md` write the full result. A model that errors shows it in its row while the others continue, and Ctrl-C prints what finished. `--record` writes cassettes per model under `assay-bench/` that replay offline (`ASSAY_MODEL_MODE=replay`), byte for byte. `priceFor` (in `@swissspidy/assay/eval`) looks up a model id's price.

  ```sh
  assay bench -m anthropic:claude-opus-5-5 -m openai:gpt-5 -m ./my-adapter.ts --out bench.md
  ```

- [#28](https://github.com/swissspidy/assay/pull/28) [`dba3852`](https://github.com/swissspidy/assay/commit/dba38527e08f29043d0cc3b38897d85992a983af) Thanks [@swissspidy](https://github.com/swissspidy)! - The stress test is about twice as fast, with the same reports. Variants and mutants now share every part of their reference snapshot they do not change instead of copying it, and only the checks that read a changed part run again; a mutant is judged by its target check first and stops at the first failing hard check. `captureSnapshot` now takes the snapshot's digest at capture time and keeps it beside the snapshot object, so a first `verify` of a snapshot just captured takes about 0.3 ms instead of 1.5 ms; the captured snapshot is frozen with it, so the digest is always that of the evidence verified (edit a copy, made with `structuredClone`, instead). A parsed or copied snapshot computes its digest as before, and snapshot contents and records are unchanged. Pass `digest: false` to neither take the digest nor freeze the snapshot. The snapshots of the variants and mutants that `generateVariants` and `generateMutants` return share objects with the reference; do not edit them in place.

- [#19](https://github.com/swissspidy/assay/pull/19) [`dc03912`](https://github.com/swissspidy/assay/commit/dc03912487d6d484ed05cc7d16a151b36c3286b1) Thanks [@swissspidy](https://github.com/swissspidy)! - Checks can now say that a value belongs to one record. A new `each` assertion finds the records a locator matches (rows, list items, articles; a term together with the definitions that follow it, as in a `dt` with its `dd`s) and requires a nested assertion to hold inside each of them; locators and text sources inside it resolve within the record, so a value shown in another row or under another term no longer satisfies the check. A locator's `column` binds a table cell to its column header, so a title cell that reads "Open" is not the status. The `items` normalizer takes `pick`, a list of JSON Pointers, to keep several fields of each item together, so two collections whose items carry different fields can still be compared record by record; `validateCheckSet` warns about `pick` between one collection before and after the task (same fields, so the dropped ones could change), and the compiler refuses `pick` when, in every correct reference where both sides can be read, the two collections' items have exactly the same fields. `validateCheckSet` warns about a check that reads a definition found by its own content rather than through its term (the compiler refuses it), and rejects reads inside `each` that do not depend on the record. Stress testing swaps the values a record check reads with another record's, moves them out of the record, swaps one field between two JSON records, and reorders term groups as a valid variant. Existing check sets validate and evaluate as before.

- [#24](https://github.com/swissspidy/assay/pull/24) [`f9f0184`](https://github.com/swissspidy/assay/commit/f9f0184d7d5098b29e16b38533bf236b1fc0cdc7) Thanks [@swissspidy](https://github.com/swissspidy)! - Check sets now go through a review workflow: a compiled set is a proposal until a reviewer approves it (`approveCheckSet`, `assay approve`) or rejects it with a note (`rejectCheckSet`, `assay reject`). An approval can be signed with an Ed25519 key (`assay keygen`, `--key` or `ASSAY_SIGNING_KEY`), and `verify` can require a signature from a key you trust: `requireLocked: { trustedKeys }` in code, `--require-signed --trusted-key <pem>` (or `ASSAY_TRUSTED_KEYS`) on the command line; `assay validate --require-signed` is a CI gate. When a set is edited after approval, the refusal names what changed ("changed after approval: check C2 changed"). Locks made with `lockCheckSet` before this release still verify.

  `assay review` gains `--diff <old>` (what changed since the approved version, and which requirements to re-review), `--stress <report>`, and `--format github|html` for pull request comments; the review sheet also shows the evidence each check reads and validation warnings. `reviewSheet(cs, options)`, `diffCheckSets` and `formatCheckSetDiff` do the same in code. Outcome records show the lock's signature and why a lock is broken.

  ```sh
  assay approve checks/order.checks.json --reviewer alice --key alice.pem
  assay verify checks/order.checks.json snapshot.json --require-signed --trusted-key alice.pub.pem
  ```

- [#23](https://github.com/swissspidy/assay/pull/23) [`04f4eaf`](https://github.com/swissspidy/assay/commit/04f4eaf2f29e3eef17aafb6bfcd76a56922c528c) Thanks [@swissspidy](https://github.com/swissspidy)! - Route-robust compilation (ADR 0011). A check can set `"onMissing": "abstain"` for route evidence (requests, responses, the page URL): when that evidence is missing it abstains with reason `route_missing` instead of failing, evidence that is found but wrong still fails, and inside an `anyOf` the branch of the route the run took decides. The compiler takes references that did the task in different ways (`Reference.note`), refuses route evidence a correct reference lacks unless it is marked so, reports requirements whose only evidence is route evidence (`coverage[].routeOnly`) and refuses them when a probe holds the value they compare. The `items` normalizer gains `flatten`, and the compiler reads "add X" as keeping what the collection held.

- [#25](https://github.com/swissspidy/assay/pull/25) [`7608446`](https://github.com/swissspidy/assay/commit/76084464cd41abb01cf766a6166561df264728fc) Thanks [@swissspidy](https://github.com/swissspidy)! - A `sameAs` binding can take an explicit, bounded tolerance with its reason, `"tolerance": { "abs": 0.01, "because": "…" }` (minutes for date-times, days for dates, `rel` up to 5% for numbers and money), for values that correct runs give slightly differently in two sources. The validator bounds it, the review sheet shows it, and the stress test rejects values just past it and accepts values inside it. The compiler offers it only once a correct reference shows a binding that needs one. Stress testing also breaks arrays nested inside JSON values (an item removed, duplicated or changed, two nested records swapping a field) and adds the `nested-array-order` variant.

- [#22](https://github.com/swissspidy/assay/pull/22) [`ed1eb23`](https://github.com/swissspidy/assay/commit/ed1eb237b0e3d0c3786172da1e2e329ead05d0c2) Thanks [@swissspidy](https://github.com/swissspidy)! - Snapshots now cover iframes, other open pages and form uploads. `captureSnapshot` (and so `verifyPage` and `expectOutcome`) fills each `iframe` node with its frame's content, same-origin or cross-origin, named by the iframe's title, with the frame's URL as its `url`; locators find frame content like any other node, and `{"role": "iframe", "name": …}` scopes a check to one frame. A contenteditable title field (like the WordPress block editor's) now has its text as its value. Other open tabs and popups are kept as `pages`, and the snapshot's page is the active one: the page passed in, or a popup or tab it opened that was opened or navigated more recently. A new `page` assertion (`{"kind": "page", "match": {"url"?, "title"?}, "assert": …}`) reads another open page; no matching page, or several, abstains. Multipart request bodies are parsed into fields like URL-encoded ones, uploads are recorded as `{filename, type, size}` without their content, and form bodies keep their text as `requestBodyRaw`; a multipart body that was sent but could not be read makes `requestBody` checks abstain instead of fail, and a cut response body no longer makes a request body check abstain (`requestBodyTruncated` and `responseBodyTruncated` say which body was cut). `frames: false` and `pages: false` keep the previous capture. Snapshots stay `assay.snapshot/v1`, and stored snapshots load and evaluate as before. Stress testing adds an unloaded-frame mutant, mutants on the selected page, and extra-frame and extra-page variants for snapshots that have frames or several pages.

- [#31](https://github.com/swissspidy/assay/pull/31) [`e9a87c2`](https://github.com/swissspidy/assay/commit/e9a87c226d232275903468ef7594a380d8214f76) Thanks [@swissspidy](https://github.com/swissspidy)! - Write and run checks with less friction:

  - **Check builder** (`@swissspidy/assay/checks`): `checks`, `req`, `node`, `network`, `probe`, `text`, `url`, `storage`, `contains`, `each`, `page`, `allOf`, `anyOf`, `like`, `norm` and friends return exactly the `assay.checks/v1` JSON, with types and completion. Every command takes a `*.checks.ts` module where it takes a `*.checks.json`; `assay checks print --ts <file>` prints a set as builder code (and `assay checks print <file.checks.ts>` as JSON).
  - **Playwright matcher**: `await expect(page).toHaveCompleted(task, { timeout, verdict, escalate })` (and `.not`), from `@swissspidy/assay/playwright` (`expect`, or `assayMatchers` for `expect.extend`). It polls like a web-first assertion, reads `assay.config.ts`, attaches the outcome and snapshot, and fails with each requirement's verdict, each failing check's description, expected and received values, and where the evidence is.
  - **`assay watch`**: re-validates changed check sets (JSON or TypeScript, and the modules they import) and re-verifies their runs as you edit, printing a table of verdicts with what changed since the last run; `--stress` also stress-tests changed sets, `--once` runs once for CI.

  ```ts
  import { checks, like, network, probe, req } from '@swissspidy/assay/checks';

  export default checks('Add a Blue Mug to my cart.', [
    req('R1', 'The cart has a Blue Mug', { quote: 'Add a Blue Mug' })
      .check(probe('cart', '/items').like([{ name: 'Blue Mug' }]))
      .check(network.post('/api/cart/items').requestBody(like({ sku: 'MUG-BLUE' })), { onMissing: 'abstain' }),
  ]);
  ```

- [#16](https://github.com/swissspidy/assay/pull/16) [`e3c01b4`](https://github.com/swissspidy/assay/commit/e3c01b4b37b2404ff86541f1b391e8501dce6c89) Thanks [@swissspidy](https://github.com/swissspidy)! - Breaking: one `verify` function and focused entry points.

  - `verify(checkSet, snapshot, options)` replaces `verifyWithEscalation` and `verifySnapshot`. It validates the check set, runs the checks, escalates to `options.verifier` when given and returns the outcome with its record. With `recordDir` it also writes the record.

    ```ts
    // Before
    const outcome = verifySnapshot(checks, snapshot);
    const { record, proposal } = await verifyWithEscalation(checks, snapshot, { verifier });
    writeOutcomeRecord('records', record, snapshot, checks, proposal);
    // After
    const { outcome } = await verify(checks, snapshot);
    const result = await verify(checks, snapshot, { verifier, recordDir: 'records' });
    // or: writeOutcomeRecord('records', result);
    ```

  - The `EscalationResult` type is now `VerifyResult`; it also carries the validated `checkSet`, the `snapshot` and, with `recordDir`, the `written` files.
  - `writeOutcomeRecord(dir, result)` takes a `verify` result instead of `(dir, record, snapshot, checkSet, proposal?)`.
  - `expectOutcome` takes the verification options directly: `{ escalate: { verifier }, recordDir }` becomes `{ verifier, recordDir }`.
  - `verifyPage` moved to `@swissspidy/assay/playwright`. It now returns a `verify` result (`outcome`, `snapshot`, `record`, …) and can escalate with live page access.
  - `captureSnapshot`, `EvidenceRecorder` and the `CaptureOptions`, `Probe` and `RecorderOptions` types are exported from `@swissspidy/assay/playwright` only.
  - The root entry keeps verification, validation, records, locking, reports and the model interface types. The rest moved:

    | Moved to                     | Exports                                                                                                                                                                 |
    | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `@swissspidy/assay/compiler` | `compileTask`, `parseOutcomes`, `parseOutcomesDetailed`, `rubricFromClauses`, `checkRubric`, `coversClause`, `verifyCandidate`, `coverage`, `assertionTrust`            |
    | `@swissspidy/assay/stress`   | `stressTest`, `formatStressReport`, `generateVariants`, `generateMutants`, `withSuccessClaim`, `GENERIC_VARIANTS`, `mapA11y`, `editNodes`, `removeNodes`, `unwrapNodes` |
    | `@swissspidy/assay/models`   | `anthropicModel`, `toAnthropicMessages`, `fromAnthropicMessage`, `runAgent`, `replayModel`, `recordingModel`, `requestKey`                                              |
    | `@swissspidy/assay/eval`     | `llmJudge`, `JUDGE_SYSTEM`, `metrics`, `costUsd`, `PRICING`                                                                                                             |

  - No longer exported: `evaluateAssertion`, `kleeneAnd`, `kleeneOr`, `applyNormalizers`, `parseLocaleNumber`, `parseCurrency`, `parseDate`, `parseDateTime`, `NormalizeError`, `parseAriaSnapshot`, `canonical`, `matchText`, `canonicalJson`, `citedEvidence`, `sameOrigin`, `newRecordId`, `lockState` and `schemaViolations`.
  - Only `@swissspidy/assay/models` names `@anthropic-ai/sdk` in its type declarations, so TypeScript consumers of the root, `/playwright`, `/compiler`, `/stress` and `/eval` no longer need `skipLibCheck` when the SDK is not installed. (`/ai-sdk` consumers need `skipLibCheck` or `@types/json-schema`, because the AI SDK's own declarations import `json-schema`.)
  - `loadSnapshot` also checks the accessibility tree's shape (every node has a string `role`, `children` is an array) and rejects a malformed tree with an error naming the node, instead of `verify` failing later with a `TypeError`.

### Patch Changes

- [#17](https://github.com/swissspidy/assay/pull/17) [`2901795`](https://github.com/swissspidy/assay/commit/2901795910bc1c5c8b5b7f62ed15e3d4629b68f0) Thanks [@swissspidy](https://github.com/swissspidy)! - A `text` source with a `scope` now reads the scope's text whitespace-normalized, like a node's text, so a pattern with a plain space also matches non-breaking or doubled spaces. Stress testing re-renders only the part of a value that a check reads after its leading `extract`, deleting `replace` and `trim` steps, so a label the check cuts off ("Estimated delivery:") stays on the page in format variants and mutants.

## 0.1.0

The first release: compiled outcome verification for web agent tasks.

- Evidence snapshots of a page (accessibility tree, text, URL, network log, storage, backend probes)
  and a declarative check DSL that returns pass, fail or abstain.
- A Playwright fixture and `expectOutcome` that capture evidence during a run and verify it.
- A compiler that turns a task and one correct run into a check set, each check traceable to the
  task text, with stress testing against valid variants and near-miss mutants.
- Escalation of abstained requirements to an agentic verifier that cites its evidence, outcome
  records, a review sheet and check-set locking.
- An evaluation harness over three example apps (30 tasks, 123 labelled runs) and a stability run
  against simulated releases.
