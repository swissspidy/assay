/**
 * Provider-agnostic model interface. Assay uses models only at authoring time
 * (compiler, M2) and escalation time (agentic verifier, M4); the runtime never
 * calls a model.
 *
 * An adapter turns one request into one assistant turn. The agent loop
 * (`runAgent`) is provider-neutral: it executes tool calls and appends results.
 * Provider-native assistant content (e.g. thinking blocks) is carried opaquely in
 * `raw` and sent back unchanged, so adapters can honour their API's replay rules.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (object, additionalProperties: false). */
  inputSchema: Record<string, unknown>;
  /**
   * Ask the provider to guarantee schema-valid input. Only for simple schemas:
   * providers restrict which keywords strict mode accepts. Inputs are always
   * re-validated by the agent loop either way.
   */
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type ModelMessage =
  | { role: 'user'; text?: string; toolResults?: ToolResult[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw: unknown };

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

/**
 * How a turn drove the model: `tools` is the provider's native tool calling; `json` is
 * JSON-mode prompting for models without it (the tools are described in the system
 * prompt, the reply is parsed as a tool call and validated against the tool's schema,
 * with one repair retry). See ADR 0017.
 */
export type ModelMode = 'tools' | 'json';

export interface ModelTurn {
  stop: StopReason;
  text: string;
  toolCalls: ToolCall[];
  /** Provider-native assistant content to append unchanged on the next request. */
  raw: unknown;
  /**
   * Token usage. `inputTokens` counts every input token (uncached, cache reads and
   * cache writes); the cache fields break it down where the provider reports it.
   */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  /** The model that actually produced the turn (may differ after a server-side fallback). */
  model: string;
  /** How the model was driven for this turn; absent means `tools` (every turn recorded before ADR 0017). */
  mode?: ModelMode;
}

/** What a model can do, as an adapter declares it. */
export interface ModelCapabilities {
  /**
   * Native tool calling. `false` makes Assay drive the adapter in JSON mode: its requests
   * then carry no tools, and only text and earlier replies (ADR 0017). Default true.
   */
  tools?: boolean;
}

export interface ModelClient {
  /** Stable identifier recorded in outcome records, e.g. "anthropic:claude-opus-5-5". */
  readonly id: string;
  turn(request: ModelRequest): Promise<ModelTurn>;
  /** What the model supports; omitted means native tool calling. */
  readonly capabilities?: ModelCapabilities;
}

export class ModelError extends Error {
  override name = 'ModelError';
}
