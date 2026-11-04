/**
 * A `ModelClient` over a Vercel AI SDK language model, so the compiler and the
 * agentic verifier can run on any provider the AI SDK supports.
 *
 * Each `turn` is one `generateText` step. The tools are declared without
 * `execute`, so the SDK returns the model's tool calls instead of running them,
 * and Assay's own loop (`runAgent`) keeps control: it validates every input,
 * runs the read-only tools, enforces citations and records cassettes keyed on
 * the provider-neutral request.
 */
import {
  generateText,
  jsonSchema,
  type AssistantModelMessage,
  type FinishReason,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  type ToolSet,
} from 'ai';
import type { ModelClient, ModelMessage, ModelRequest, ModelTurn, StopReason, ToolCall, ToolSpec } from './types.ts';
import { ModelError } from './types.ts';

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

export interface AiSdkOptions {
  /**
   * Identifier recorded in outcome records and cassettes. Defaults to
   * `<provider>:<modelId>` (or the model string for a gateway model id). Give it
   * when the provider options change what the model does, so a cassette recorded
   * with one setting is not replayed for another.
   */
  id?: string;
  /** Passed to `generateText` unchanged, e.g. `{ anthropic: { thinking: { type: 'adaptive' } } }`. */
  providerOptions?: ProviderOptions;
  maxOutputTokens?: number;
  /** Retries on transient API errors (the AI SDK's default is 2). */
  maxRetries?: number;
}

const STOP: Record<FinishReason, StopReason> = {
  'tool-calls': 'tool_use',
  stop: 'end_turn',
  length: 'max_tokens',
  'content-filter': 'refusal',
  error: 'other',
  other: 'other',
};

const isAssistant = (m: unknown): m is AssistantModelMessage =>
  !!m && typeof m === 'object' && (m as { role?: unknown }).role === 'assistant';

/**
 * Assay's messages as AI SDK messages. An assistant turn is sent back as the
 * SDK's own response messages (kept in `raw`), so reasoning and provider
 * metadata survive; tool results become a `tool` message.
 */
export function toAiSdkMessages(messages: ModelMessage[]): SdkMessage[] {
  const toolNames = new Map<string, string>();
  const out: SdkMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const c of m.toolCalls) toolNames.set(c.id, c.name);
      const raw = Array.isArray(m.raw) ? m.raw.filter(isAssistant) : [];
      if (raw.length) out.push(...raw);
      else {
        out.push({
          role: 'assistant',
          content: [
            ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
            ...m.toolCalls.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.id,
              toolName: c.name,
              input: c.input,
            })),
          ],
        });
      }
      continue;
    }
    if (m.toolResults?.length) {
      out.push({
        role: 'tool',
        content: m.toolResults.map((r) => ({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: toolNames.get(r.toolCallId) ?? 'unknown',
          output: r.isError
            ? { type: 'error-text' as const, value: r.content }
            : { type: 'text' as const, value: r.content },
        })),
      });
    }
    if (m.text) out.push({ role: 'user', content: m.text });
  }
  return out;
}

function toolSet(tools: ToolSpec[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    // No `execute`: the SDK returns the call and the agent loop runs (and validates) it.
    set[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      ...(t.strict ? { strict: true } : {}),
    };
  }
  return set;
}

function defaultId(model: LanguageModel): string {
  return typeof model === 'string' ? model : `${model.provider}:${model.modelId}`;
}

/**
 * Wrap an AI SDK language model (`anthropic('…')`, `openai('…')`, a gateway id, …)
 * as an Assay `ModelClient`.
 */
export function aiSdkModel(model: LanguageModel, opts: AiSdkOptions = {}): ModelClient {
  const fallbackModelId = typeof model === 'string' ? model : model.modelId;
  return {
    id: opts.id ?? defaultId(model),
    async turn(req: ModelRequest): Promise<ModelTurn> {
      let res: Awaited<ReturnType<typeof generateText>>;
      try {
        res = await generateText({
          model,
          instructions: req.system,
          messages: toAiSdkMessages(req.messages),
          tools: toolSet(req.tools),
          ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
          ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
          ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        });
      } catch (e) {
        throw new ModelError(`AI SDK error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      // Invalid calls (unparseable input, unknown tool) are passed on as they are: the
      // agent loop answers them with an error result the model can act on.
      const toolCalls: ToolCall[] = res.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input }));
      const u = res.usage;
      const cacheRead = u.inputTokenDetails?.cacheReadTokens;
      const cacheWrite = u.inputTokenDetails?.cacheWriteTokens;
      return {
        stop: STOP[res.finishReason] ?? 'other',
        text: res.text,
        toolCalls,
        // Only the assistant message: tool results come from the agent loop.
        raw: res.response.messages.filter(isAssistant),
        usage: {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
          ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
        },
        model: res.response.modelId || fallbackModelId,
      };
    },
  };
}
