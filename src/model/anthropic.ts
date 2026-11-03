import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelMessage, ModelRequest, ModelTurn, StopReason, ToolCall } from './types.ts';
import { ModelError } from './types.ts';

/* The SDK is an optional peer dependency: types are erased, the module is loaded only when this adapter is used. */
type SDK = typeof Anthropic;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

/** The subset of the SDK client the adapter uses (injectable for tests). */
export interface AnthropicLike {
  beta: { messages: { stream(params: StreamParams): { finalMessage(): Promise<BetaMessage> } } };
}

export interface AnthropicOptions {
  /** Defaults to $ASSAY_MODEL or claude-opus-5-5. */
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
  /** Re-issue a request whose streamed tool input could not be parsed (default 2 retries). */
  parseRetries?: number;
  apiKey?: string;
  baseURL?: string;
  /** Pre-built client (tests, custom transports). The SDK is still needed for error classes. */
  client?: AnthropicLike;
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
};

export function toAnthropicMessages(messages: ModelMessage[]): BetaMessageParam[] {
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

export function fromAnthropicMessage(msg: BetaMessage): ModelTurn {
  const toolCalls: ToolCall[] = [];
  const text: string[] = [];
  for (const b of msg.content) {
    if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input });
    else if (b.type === 'text') text.push(b.text);
  }
  const u = msg.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    stop: STOP[msg.stop_reason ?? ''] ?? 'other',
    text: text.join('\n'),
    toolCalls,
    raw: msg.content,
    usage: {
      inputTokens: u.input_tokens + cacheRead + cacheWrite,
      outputTokens: u.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
    model: msg.model,
  };
}

/** Claude via the official Anthropic SDK (Messages API, streamed, adaptive thinking, prompt caching). */
export async function anthropicModel(opts: AnthropicOptions = {}): Promise<ModelClient> {
  let sdk: SDK;
  try {
    sdk = (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new ModelError('anthropicModel requires the optional dependency @anthropic-ai/sdk (npm i @anthropic-ai/sdk)');
  }
  const model = opts.model ?? process.env.ASSAY_MODEL ?? 'claude-opus-5-5';
  const effort = opts.effort ?? 'high';
  const client: AnthropicLike =
    opts.client ??
    new sdk({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  const useFallbacks = opts.fallbacks ?? true;
  const retries = opts.parseRetries ?? 2;

  return {
    // Effort is part of the identity: a cassette recorded at one effort must not replay for another.
    id: `anthropic:${model}@${effort}`,
    async turn(req: ModelRequest): Promise<ModelTurn> {
      const params: StreamParams = {
        model,
        max_tokens: opts.maxTokens ?? 32000,
        // Agent loops re-send a stable prefix (tools, system, earlier turns) every turn.
        cache_control: { type: 'ephemeral' },
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as { type: 'object' },
          ...(t.strict ? { strict: true } : {}),
          // Inputs stream as generated; the agent loop validates them against the schema.
          eager_input_streaming: true,
        })),
        output_config: { effort },
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      };
      for (let attempt = 0; ; attempt++) {
        try {
          return fromAnthropicMessage(await client.beta.messages.stream(params).finalMessage());
        } catch (e) {
          if (e instanceof sdk.APIError) throw new ModelError(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
          // A tool input that streamed as invalid JSON is a client-side SDK error, not an
          // API error: re-issue the identical request a bounded number of times.
          if (e instanceof sdk.AnthropicError && attempt < retries) continue;
          if (e instanceof sdk.AnthropicError)
            throw new ModelError(`Anthropic SDK error after ${retries + 1} attempts: ${e.message}`);
          throw e;
        }
      }
    },
  };
}
