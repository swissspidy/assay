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

export interface ModelTurn {
  stop: StopReason;
  text: string;
  toolCalls: ToolCall[];
  /** Provider-native assistant content to append unchanged on the next request. */
  raw: unknown;
  usage: { inputTokens: number; outputTokens: number };
  /** The model that actually produced the turn (may differ after a server-side fallback). */
  model: string;
}

export interface ModelClient {
  /** Stable identifier recorded in outcome records, e.g. "anthropic:claude-opus-5-5". */
  readonly id: string;
  turn(request: ModelRequest): Promise<ModelTurn>;
}

export class ModelError extends Error {
  override name = 'ModelError';
}
