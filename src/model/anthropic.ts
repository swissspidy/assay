import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelMessage, ModelRequest, ModelTurn, StopReason, ToolCall } from './types.ts';
import { ModelError } from './types.ts';

export interface AnthropicOptions {
  /** Defaults to claude-opus-5-5. */
  model?: string;
  /** Effort level; set explicitly because the default differs by model. Default "high". */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Default 32000 (requests are streamed, so large values do not time out). */
  maxTokens?: number;
  /**
   * Server-side refusal fallback ("default" routes by refusal category). On by
   * default; set false to disable, e.g. on platforms that reject it.
   */
  fallbacks?: boolean;
  apiKey?: string;
  baseURL?: string;
}

/* The SDK is an optional peer dependency: types are erased, the module is loaded only when this adapter is used. */
type SDK = typeof Anthropic;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
};

function toParams(messages: ModelMessage[]): BetaMessageParam[] {
  return messages.map((m): BetaMessageParam => {
    if (m.role === 'assistant') return { role: 'assistant', content: m.raw as BetaMessage['content'] };
    const content: BetaContentBlockParam[] = [];
    for (const r of m.toolResults ?? []) {
      content.push({
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: r.content,
        is_error: r.isError ?? false,
      });
    }
    if (m.text) content.push({ type: 'text', text: m.text });
    return { role: 'user', content };
  });
}

/** Claude via the official Anthropic SDK (Messages API, streamed, adaptive thinking). */
export async function anthropicModel(opts: AnthropicOptions = {}): Promise<ModelClient> {
  let sdk: SDK;
  try {
    sdk = (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new ModelError('anthropicModel requires the optional dependency @anthropic-ai/sdk (npm i @anthropic-ai/sdk)');
  }
  const model = opts.model ?? process.env.ASSAY_MODEL ?? 'claude-opus-5-5';
  const client = new sdk({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  const useFallbacks = opts.fallbacks ?? true;

  return {
    id: `anthropic:${model}`,
    async turn(req: ModelRequest): Promise<ModelTurn> {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: opts.maxTokens ?? 32000,
        system: req.system,
        messages: toParams(req.messages),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as { type: 'object' },
          ...(t.strict ? { strict: true } : {}),
          // Inputs stream as generated; the agent loop validates them against the schema.
          eager_input_streaming: true,
        })),
        output_config: { effort: opts.effort ?? 'high' },
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      let msg: BetaMessage;
      try {
        msg = await stream.finalMessage();
      } catch (e) {
        if (e instanceof sdk.APIError) throw new ModelError(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
        // Truncated eager tool input surfaces as a JSON error: report it as max_tokens.
        if (e instanceof SyntaxError) {
          return {
            stop: 'max_tokens',
            text: '',
            toolCalls: [],
            raw: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            model,
          };
        }
        throw e;
      }
      const toolCalls: ToolCall[] = [];
      const text: string[] = [];
      for (const b of msg.content) {
        if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input });
        else if (b.type === 'text') text.push(b.text);
      }
      return {
        stop: STOP[msg.stop_reason ?? ''] ?? 'other',
        text: text.join('\n'),
        toolCalls,
        raw: msg.content,
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
        model: msg.model,
      };
    },
  };
}
