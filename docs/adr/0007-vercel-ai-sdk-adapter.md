# ADR 0007: Vercel AI SDK adapter

- Status: Accepted
- Date: 2026-11-04

## Context

Models run in two places: the compiler (ADR 0002) and the agentic verifier that escalation calls
(ADR 0004). Both go through `ModelClient`, a one-request-one-turn interface, and through `runAgent`,
Assay's own tool loop. The only adapter was `anthropicModel`, over the Anthropic SDK.

The question was whether the Vercel AI SDK (`ai`) could simplify escalation. It offers two things:

1. **Providers.** One `LanguageModel` type over Anthropic, OpenAI, Google, Bedrock, a gateway and
   many others, with tools declared as JSON Schema, normalized usage and finish reasons, and
   retries.
2. **A tool loop.** `generateText` with `execute` functions on the tools and a `stopWhen` condition
   runs the whole agent loop itself.

The second does not fit. Assay's loop does work the SDK's loop would hide or skip:

- **Cassettes.** Each turn is recorded under a digest of Assay's provider-neutral `ModelRequest`
  plus the model id (ADR 0002). The committed cassettes and the measured evaluation (ADR 0005) depend
  on those exact requests. Inside the SDK's loop, per-turn requests are internal: recordings would be
  keyed on the SDK's prompt format and break with its releases.
- **Validation in the loop.** Every tool input is validated before the tool runs. The compiler's
  `submit_checks` validates, runs and stress-tests a submission and sends the errors back; the
  verifier's `submit_verdict` rejects uncited or made-up citations. A terminal tool ends the loop,
  and later calls in the same turn do not run. Nudges, the turn limit, and refusal and `max_tokens`
  checks before any tool runs are Assay's too.
- **Read-only access** is enforced by the tools themselves (ADR 0004), not by the loop, so moving the
  loop gains nothing there.

`runAgent` is about 120 lines. Replacing it would save little and lose all of the above.

## Decision

- **`aiSdkModel(model, options)`** wraps an AI SDK `LanguageModel` as a `ModelClient`. It is exported
  from `@swissspidy/assay/ai-sdk`; `ai` (7 or later) is an optional peer dependency, like
  `@anthropic-ai/sdk`. No other entry point imports it.
- **One turn is one `generateText` step.** The tools are declared with `jsonSchema()` and **no
  `execute`**, so the call returns the model's tool calls and `runAgent` runs them. The SDK does not
  validate inputs (`jsonSchema()` without a validator); the loop does, as for every adapter. An
  unparseable input or an unknown tool name is passed on as it is, and the loop answers it with an
  error result.
- **Mapping:**
  - the system prompt goes to `instructions`; user text to a user message; tool results to a
    `tool` message (as `text` or `error-text`, with the tool name looked up from the assistant turn);
  - the assistant turn's `raw` is the SDK's own response message, sent back unchanged on the next
    turn, so reasoning parts and provider metadata (for example thinking signatures) survive, and a
    replayed run issues the same requests;
  - finish reasons: `tool-calls` → `tool_use`, `stop` → `end_turn`, `length` → `max_tokens`,
    `content-filter` → `refusal`, anything else → `other`;
  - usage: input and output tokens, plus cache reads and writes where the provider reports them;
  - the served model is the response's model id;
  - SDK errors become `ModelError`.
- **Options:** `id`, `providerOptions` (passed through), `maxOutputTokens`, `maxRetries`. The id
  defaults to `<provider>:<modelId>`. It is part of every cassette key, so a caller that changes what
  the model does through `providerOptions` (effort, thinking) should give its own id.
- **`anthropicModel` stays the default** for the scripts, the committed cassettes and the measured
  numbers. It sets things the AI SDK's Anthropic provider does not all expose the same way
  (server-side refusal fallbacks, eager input streaming, retries of tool input that streamed as
  invalid JSON), and changing it would change every recorded request.

(Amended by [ADR 0017](0017-config-file-and-bring-your-own-model.md): `aiSdkModel` takes a
`mode`, `auto` by default, and drives models without tool calling in JSON mode; its turns are
marked `mode: "tools"` or `"json"`.)

## Consequences

- The compiler and the verifier run on any provider the AI SDK supports, with the same loop,
  validation, citations and cassettes.
- Cassettes are per adapter: a run through `aiSdkModel(anthropic(…))` records different requests
  (another id, another `raw` format) than `anthropicModel()`, and the two do not replay each other.
- The evaluation numbers are measured with `anthropicModel` only. Other models need their own runs
  of `scripts/eval.ts` before their numbers mean anything.
- Strict tool schemas (`ToolSpec.strict`) are passed on; whether a provider honours them is up to it.
  Inputs are validated by the loop either way.
- The adapter is tested against the AI SDK's `MockLanguageModelV4`, including a full escalation
  through `verify` and a record-then-replay round trip (`tests/unit/ai-sdk.spec.ts`).
