/**
 * `@swissspidy/assay/ai-sdk`: a `ModelClient` over a Vercel AI SDK language model, so the
 * compiler and the agentic verifier can run on any provider the AI SDK supports.
 *
 * Each `turn` is one `generateText` step. The tools are declared without `execute`, so the
 * SDK returns the model's tool calls instead of running them, and Assay's own loop
 * (`runAgent`) keeps control: it validates every input, runs the read-only tools, enforces
 * citations and records cassettes keyed on the provider-neutral request.
 */
import { generateText, jsonSchema, type LanguageModel } from 'ai';
import { createAiSdkModel, type AiSdkOptions } from './ai-sdk-core.ts';
import type { ModelClient } from './types.ts';

export { toAiSdkMessages, toolsUnsupportedError, toolsUnsupportedWarning, type AiSdkOptions } from './ai-sdk-core.ts';

/**
 * Wrap an AI SDK language model (`anthropic('…')`, `openai('…')`, `ollama('…')`, a gateway
 * id, …) as an Assay `ModelClient`. Models without tool calling are driven in JSON mode
 * (see `AiSdkOptions.mode`).
 */
export function aiSdkModel(model: LanguageModel, opts: AiSdkOptions = {}): ModelClient {
  return createAiSdkModel({ generateText, jsonSchema }, model, opts);
}
