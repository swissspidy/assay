# ADR 0017: Config file and bring your own model

- Status: Accepted
- Date: 2026-11-06
- Scope: package (`defineConfig`, `loadConfig`, `resolveModel`, `assay init`, `--config`), model
  adapters (JSON mode), cassette keys, outcome records
- Amends: [ADR 0007](0007-vercel-ai-sdk-adapter.md), [ADR 0010](0010-command-line-tool.md)

## Context

Assay needs a model in two places only: compiling checks and deciding what the checks abstain on
(escalation). Using one meant either writing code (`anthropicModel()`, `aiSdkModel(anthropic(…))`)
or setting `--provider` / `--model` / `ASSAY_PROVIDER` / `ASSAY_MODEL` on every command, where the
only providers were the Anthropic SDK and the AI SDK's default (gateway) provider. Project defaults
(where check sets live, a record directory, required locks, trusted keys, stress variants to skip)
had to be repeated as flags.

Two further problems:

- Assay's agent loop sends tools and expects tool calls. Many models people run themselves (small
  Ollama models, some open-weights deployments) have no tool calling; the provider either rejects
  the request or drops the tools and answers in prose, and the loop gave up.
- A model is configured once per project, but most commands (verify without escalation, stress,
  validate, review) never need one, and must not start requiring one.

## Decision

### `assay.config.ts`

`defineConfig(config)` (exported from the package root) types a config file, looked up in the
current directory as `assay.config.ts`, `.mts`, `.js` or `.mjs` (in that order), or given with
`--config <file>` / `loadConfig({ path })`:

```ts
import { defineConfig } from '@swissspidy/assay';

export default defineConfig({
  model: 'anthropic:claude-opus-5-5', // or anthropic('…'), or { id, turn(request) }
  modelOptions: { mode: 'auto' }, // auto | tools | json; id, providerOptions, maxOutputTokens, maxRetries
  checks: 'checks', // a directory (every *.checks.json under it) or a glob: `assay validate` with no files
  snapshots: 'snapshots', // where `assay capture` writes by default
  recordDir: 'assay-records', // an outcome record for every verify
  escalate: true, // or a policy { on, includeSoft }; uses `model`
  requireLocked: 'signed', // true | false | 'signed'
  trustedKeys: ['keys/'], // PEM files, directories of .pem files, or PEM text
  stress: { skipVariants: ['reorder'], successClaims: true },
});
```

- **Loading.** The file is imported with Node's own loader. Node 24 (the minimum, ADR 0006) strips
  TypeScript types itself, so a `.ts` config needs no build step and no extra dependency; it must
  use erasable syntax only (no `enum`, no parameter properties). The default export may be an
  object, or a (possibly async) function returning one. A config wrapped by a CommonJS loader
  (`{ default: { default: … } }`) is unwrapped. Loads are cached per file for the process.
- **Validation.** Unknown keys are errors naming the file and the valid keys (a typo such as
  `modle` would otherwise silently do nothing), as are wrong types and `requireLocked: 'signed'`
  without `trustedKeys`. Paths are resolved against the config file's directory, not the
  current directory, so a config works from any subdirectory it is passed to.
- **`model` is never resolved unless it is used.** Resolution is lazy everywhere: `verify` resolves
  the configured model only when a requirement actually escalates, and the CLI only in `compile`
  and in `verify --escalate` when something escalates. `model` may also be a function returning a
  model, so a config can import its provider lazily (`model: async () => (await import('…')).x('…')`)
  and stay loadable where that provider is not installed.

### Precedence

For every setting: **flags > environment variables > config file > built-in defaults**. In code,
explicit options win over a config. Concretely:

| Setting        | Flag                                                 | Environment                     | Config                  | Default                                                        |
| -------------- | ---------------------------------------------------- | ------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Model          | `--model`, `--provider`                              | `ASSAY_MODEL`, `ASSAY_PROVIDER` | `model`, `modelOptions` | `anthropicModel()` when `ANTHROPIC_API_KEY` is set; else error |
| Escalation     | `--escalate` / `--no-escalate`                       |                                 | `escalate`              | off                                                            |
| Record dir     | `--record`                                           |                                 | `recordDir`             | none                                                           |
| Required lock  | `--require-locked`, `--require-signed` (and `--no-`) |                                 | `requireLocked`         | off                                                            |
| Trusted keys   | `--trusted-key`                                      | `ASSAY_TRUSTED_KEYS`            | `trustedKeys`           | none                                                           |
| Stress         | `--skip-variants`, `--no-claims`                     |                                 | `stress`                | none skipped, claims on                                        |
| Capture output | `--out`                                              |                                 | `snapshots`             | stdout                                                         |
| Check sets     | file arguments to `validate`                         |                                 | `checks`                | (usage error)                                                  |

Environment variables rank above the config because they are set per invocation (CI jobs,
`ASSAY_MODEL_MODE` replays) and the existing scripts and workflows rely on them; every variable
that worked before keeps working. Within one level, a flag or variable is taken as a whole: a
flag-level `--model` replaces the config's model and its `modelOptions` (a `provider:model`
string keeps the config's `mode`).
`--model provider:model` (and `ASSAY_MODEL=provider:model`) is the config's string form; a bare
model id keeps its old meaning (`--provider`, default `anthropic`), so `ASSAY_MODEL=claude-…`
selects what it did before.

### Who reads the config

**Core library functions never read `assay.config.*` by themselves.** `compileTask`, `verify` and
`verifyMany` stay pure and reproducible: the same arguments give the same result wherever the
process runs. They use a config only when passed one, as `config: AssayConfig | string` (an
object or a file path; `loadConfig()` finds the project's); the default is no config.

- `compileTask(task, refs, opts?)`: `opts.model` (any of the three forms) wins; without it the
  given config's `model` and `modelOptions`; without either it throws, naming the three forms.
- `verify` / `verifyMany`: `recordDir`, `requireLocked`, `trustedKeys`, `policy` and escalation
  come from the given config where the options do not set them. `escalate: false` turns off
  escalation the config asks for; an explicit `verifier` always escalates.
- `stressTest` is synchronous and takes its options explicitly
  (`stressTest(cs, refs, (await loadConfig()).config.stress)`).

**App-level entry points read it by default:**

- the CLI, from `--config <file>` or the current directory (it merges the flags itself and passes
  the result on with `config: false`, so nothing is applied twice);
- the Playwright helpers `verifyPage` and `expectOutcome`, from the current directory, loaded once
  per process and cached. A `config` option passes another (object or path); `config: false`
  turns it off. The config's `requireLocked` is enforced before capturing, like the option.

A test suite is an application: it has a project directory and wants the project's defaults (a
record directory, required locks, escalation) without repeating them in every call. A library
call deep in someone else's code should not change behaviour because of a file in whatever
directory the process started in.

### Three model forms

`resolveModel(input, options)` (root and `/models`) turns what the user wrote into a `ModelClient`:

1. **A Vercel AI SDK `LanguageModel`** (`anthropic('…')`, `openai('…')`, `ollama('…')`), recognised
   structurally (`doGenerate`, `modelId`), wrapped by `aiSdkModel` (ADR 0007). The config's types
   describe it structurally too (`LanguageModelLike`), so they do not depend on `ai`.
2. **A custom adapter**: any object with `id` and `turn(request)`, using Assay's own
   `ModelRequest` / `ModelTurn` types; no AI SDK needed. It can declare
   `capabilities: { tools: false }` (see JSON mode).
3. **A `'provider:model'` string**, resolved through the provider's AI SDK package:
   `anthropic` → `@ai-sdk/anthropic`, `openai`, `google`, `google-vertex`, `amazon-bedrock`,
   `azure`, `mistral`, `groq`, `xai`, `deepseek`, `cohere`, `cerebras`, `fireworks`,
   `togetherai`, `perplexity` → `@ai-sdk/<name>`, `ollama` → `ollama-ai-provider-v2`,
   `openrouter` → `@openrouter/ai-sdk-provider`, `gateway` → `ai`. The string is split at the
   first colon (`ollama:llama3.1:8b`). A string with a slash and no known provider
   (`anthropic/claude-opus-5-5`) goes to the AI SDK's default (gateway) provider, as
   `--provider ai-sdk` did. The string itself is the client's id, so cassettes and records name
   what the user wrote. A missing package is an error naming every package to install
   (`npm i -D ai @ai-sdk/anthropic`); an unknown provider lists the known ones.

`ai` stays an optional peer dependency, and provider packages are the user's own dependencies, not
declared by Assay. Both are imported lazily, first from Assay's own location and then from the
project directory (for a linked or global Assay).

When nothing is configured, the error says what needs a model and shows the three forms, plus,
from the CLI, `--model`, `ANTHROPIC_API_KEY` and `--cassette`.

### JSON mode and capability detection

Each turn is driven in one of two **modes**:

- `tools`: the provider's native tool calling, as before.
- `json`: for models without it. The wrapped model gets requests **without tools**: the tools are
  described in the system prompt (name, description, input JSON Schema) with the reply format
  `{"tool": "<name>", "input": { … }}`; earlier assistant turns are sent back as the JSON they
  replied (or, for a turn driven with tools, their calls written as JSON); tool results are sent
  as user text (`Result of <tool>:` / `Error from <tool>:`). The reply is parsed (the whole text,
  a fenced block, or from the first brace; an array or `{ calls: [...] }` gives several calls)
  and each call is validated against its tool's schema with Ajv. An invalid reply gets **one
  repair retry** that sends the reply back with the errors. A reply still invalid after it is
  passed on when it names a known tool, so the agent loop answers it with its usual
  `Invalid input` result, which the model can act on; one with no call at all is a text turn,
  which the loop nudges. Call ids are deterministic (`json_<turn>_<n>`), so a replay issues the
  same requests.

`jsonModeModel(inner)` implements this over any `ModelClient`. How a mode is chosen:

- **Declared.** `modelOptions.mode: 'tools' | 'json'` forces one; a custom adapter declaring
  `capabilities: { tools: false }` is driven in JSON mode.
- **Detected (AI SDK, `mode: 'auto'`, the default).** The AI SDK has no static "supports tools"
  flag, and the provider-level specs do not carry one either, so detection is by the provider's
  answer to the first request with tools:
  - an `UnsupportedFunctionalityError` about tools, or a provider error whose message says the
    model does not support tools or function calling (Ollama: "… does not support tools"), or
  - a successful call whose warnings say the tools were ignored
    (`{ type: 'unsupported', feature: 'tools' }`, and the older `unsupported-tool` /
    `unsupported-setting` forms).

  The request is then repeated in JSON mode (the discarded call's tokens are still counted), and
  the client stays in JSON mode for the rest of its life. Any other error is thrown as before.
  "Structured output" is not a separate requirement: Assay's structured output _is_ the tool
  input, validated by the loop in either mode, so a model with tools needs nothing else, and a
  model without them is asked for JSON and validated the same way.

The mode is explicit wherever a model ran:

- `ModelTurn.mode` (`'tools' | 'json'`); absent means `tools`, which is what every turn recorded
  before this ADR was.
- `AgentRun.modes` and `VerifierResult.modes`: the modes over a run's turns.
- `CompileReport.modes` and the outcome record's `escalation.modes`: present when a turn was not
  native tool calling, so every earlier report and record (and every report a replay reproduces)
  stays byte for byte as it was.

### Cassette keys

The key of a recorded turn is a digest of the model id, the mode and the provider-neutral request:

- `tools`: `sha256(canonicalJson({ model, request }))`, the key every existing cassette already
  uses. The mode is encoded by its absence, so committed cassettes are tools-mode cassettes as they
  stand and replay byte for byte without being re-recorded or rewritten.
- `json`: `sha256(canonicalJson({ model, mode: 'json', request }))`.

The request is the same in both modes (JSON mode works below the recording layer), so the mode in
the key is what keeps a JSON-mode recording from being replayed for a native-tools run of the same
model id. Recording keys a turn by the mode it reports. `replayModel(path)` looks a request up under
either key; `replayModel(path, { mode })` only under that mode's (the CLI passes a forced
`modelOptions.mode`).

### `assay init`

Writes `assay.config.ts` in the current directory and asks nothing. The model defaults to
`'anthropic:claude-opus-5-5'`, the model every published number was measured with (ADR 0005), and
comments show the other two forms, other provider strings, `capabilities: { tools: false }`,
`modelOptions.mode`, and the other settings (commented out except `checks` and `snapshots`). It
refuses to replace an existing config unless `--force`, and prints what to install next.

## Consequences

- A project names its model once, in any of three forms, with no code; every command and the
  Playwright helpers pick it up, library calls take it when passed, and commands that need no
  model never load it.
- Models without tool calling (small local models) can compile and escalate. How well they do is
  not measured: the evaluation (ADR 0005, ADR 0009) used `anthropicModel` with native tools only.
  JSON mode costs more tokens (the schemas sit in the system prompt, and a repair is a second call)
  and its replies are only as good as the model's JSON.
- Detection depends on how providers report missing tool support; a provider that silently drops
  the tools without a warning reads as a model that chose not to call one, and the loop nudges and
  eventually gives up. `modelOptions.mode: 'json'` is the remedy.
- `verify`, `verifyMany` and `compileTask` behave exactly as before unless given a config, so
  verdicts, records and the equivalence golden are unchanged. `verifyPage` and `expectOutcome`
  read the project's config once per process; with no config file nothing changes.
- No committed cassette, check set or report changes: replays of the example and real-app compiles
  reproduce them byte for byte.
- A cassette recorded through the string form has the string as its model id; one recorded with
  `aiSdkModel(anthropic('…'))` has `anthropic.messages:…`. They are different ids and do not
  replay each other (as ADR 0007 already noted for adapters).
