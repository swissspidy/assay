/**
 * JSON mode: tool calling for models that have none (ADR 0017).
 *
 * The wrapped model is sent requests without tools: the tools are described in the
 * system prompt, and the model is asked to reply with one JSON object naming a tool and
 * its input. The reply is parsed and validated against the tool's input schema; an
 * invalid reply gets one repair retry, with the errors. The result is an ordinary
 * `ModelTurn` with tool calls, marked `mode: "json"`, so the agent loop, citations and
 * cassettes work as with native tool calling.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import type { ModelClient, ModelMessage, ModelRequest, ModelTurn, ToolCall, ToolSpec } from './types.ts';

const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new WeakMap<object, ValidateFunction>();

function validator(schema: Record<string, unknown>): ValidateFunction {
  let v = validators.get(schema);
  if (!v) validators.set(schema, (v = ajv.compile(schema)));
  return v;
}

/** What a JSON-mode assistant turn keeps in `raw`: the reply text and the wrapped model's own raw content. */
interface JsonRaw {
  mode: 'json';
  text: string;
  inner: unknown;
}

const isJsonRaw = (raw: unknown): raw is JsonRaw =>
  !!raw && typeof raw === 'object' && (raw as { mode?: unknown }).mode === 'json';

export const JSON_CALL_FORMAT = '{"tool": "<tool name>", "input": { ... }}';

/** The system prompt with the tools described in it. */
export function jsonModeSystem(system: string, tools: ToolSpec[]): string {
  if (!tools.length) return system;
  return [
    system,
    '# Tools',
    `Tools are not available as function calls here. To call a tool, reply with only one JSON object, with no other text and no code fence:\n${JSON_CALL_FORMAT}\nThe input must match the tool's JSON Schema. Call one tool per reply; its result comes back in the next message.`,
    ...tools.map((t) => `## ${t.name}\n${t.description}\nInput schema: ${JSON.stringify(t.inputSchema)}`),
  ].join('\n\n');
}

const asCall = (c: ToolCall) => JSON.stringify({ tool: c.name, input: c.input });

/**
 * The conversation without tool calls: an assistant turn becomes the JSON it replied (or
 * its tool calls written as JSON, for a turn driven with native tools), tool results
 * become user text.
 */
export function jsonModeMessages(messages: ModelMessage[]): ModelMessage[] {
  const names = new Map<string, string>();
  return messages.map((m): ModelMessage => {
    if (m.role === 'assistant') {
      for (const c of m.toolCalls) names.set(c.id, c.name);
      if (isJsonRaw(m.raw)) return { role: 'assistant', text: m.raw.text, toolCalls: [], raw: m.raw.inner };
      const text = [m.text, ...m.toolCalls.map(asCall)].filter(Boolean).join('\n');
      return { role: 'assistant', text, toolCalls: [], raw: undefined };
    }
    const parts = (m.toolResults ?? []).map(
      (r) => `${r.isError ? 'Error from' : 'Result of'} ${names.get(r.toolCallId) ?? 'the tool'}:\n${r.content}`,
    );
    if (m.text) parts.push(m.text);
    return { role: 'user', text: parts.join('\n\n') };
  });
}

/** The first JSON value in a reply: the whole text, else inside a code fence, else from the first brace. */
function extractJson(text: string): unknown {
  const t = text.trim();
  const candidates = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) candidates.push(fence[1]!.trim());
  const start = t.search(/[[{]/);
  if (start >= 0) {
    const close = t[start] === '{' ? '}' : ']';
    candidates.push(t.slice(start, t.lastIndexOf(close) + 1));
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export interface ParsedReply {
  /** Calls naming a known tool (their input may still be invalid; see `errors`). */
  calls: { name: string; input: unknown }[];
  /** Why the reply is not a valid tool call; empty when it is. */
  errors: string[];
}

/** Parse a JSON-mode reply into tool calls and validate each against its tool's schema. */
export function parseJsonReply(text: string, tools: ToolSpec[]): ParsedReply {
  const json = extractJson(text);
  if (json === undefined) return { calls: [], errors: ['the reply holds no JSON object'] };
  const items: unknown[] = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { calls?: unknown }).calls)
      ? (json as { calls: unknown[] }).calls
      : [json];
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  const calls: ParsedReply['calls'] = [];
  const errors: string[] = [];
  for (const item of items) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const name = o.tool ?? o.name;
    const input = o.input ?? o.arguments ?? o.parameters;
    if (typeof name !== 'string') {
      errors.push(`expected ${JSON_CALL_FORMAT}, got ${JSON.stringify(item).slice(0, 200)}`);
      continue;
    }
    const tool = byName.get(name);
    if (!tool) {
      errors.push(`unknown tool ${JSON.stringify(name)} (tools: ${[...byName.keys()].join(', ')})`);
      continue;
    }
    calls.push({ name, input });
    const validate = validator(tool.inputSchema);
    if (!validate(input)) errors.push(`${name} input: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
  }
  if (!items.length) errors.push('the reply holds no tool call');
  return { calls, errors };
}

/** An empty reply keeps an empty `raw`, so the agent loop does not send it back (providers reject empty turns). */
const jsonRaw = (t: ModelTurn): JsonRaw | [] => (t.text ? { mode: 'json', text: t.text, inner: t.raw } : []);

const add = (a: ModelTurn['usage'], b: ModelTurn['usage']): ModelTurn['usage'] => {
  const out: ModelTurn['usage'] = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined)
    out.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined)
    out.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  return out;
};

/**
 * Drive `inner` in JSON mode. Its requests carry no tools; every turn it answers is
 * returned as `mode: "json"`. The id stays the wrapped model's: the cassette key
 * records the mode separately (ADR 0017).
 */
export function jsonModeModel(inner: Pick<ModelClient, 'id' | 'turn'>): ModelClient {
  return {
    id: inner.id,
    capabilities: { tools: false },
    async turn(req: ModelRequest): Promise<ModelTurn> {
      const system = jsonModeSystem(req.system, req.tools);
      const messages = jsonModeMessages(req.messages);
      const first = await inner.turn({ system, messages, tools: [] });
      if (!req.tools.length || first.stop === 'refusal' || first.stop === 'max_tokens') {
        return { ...first, raw: jsonRaw(first), mode: 'json' };
      }
      let reply = first;
      let usage = first.usage;
      let parsed = parseJsonReply(first.text, req.tools);
      if (parsed.errors.length) {
        // One repair retry, with what was wrong.
        const retry = await inner.turn({
          system,
          tools: [],
          messages: [
            ...messages,
            ...(first.text ? [{ role: 'assistant' as const, text: first.text, toolCalls: [], raw: first.raw }] : []),
            {
              role: 'user',
              text: `${first.text ? 'That reply is not a valid tool call' : 'The reply was empty'}: ${parsed.errors.join('; ')}. Reply again with only the corrected JSON object: ${JSON_CALL_FORMAT}`,
            },
          ],
        });
        usage = add(usage, retry.usage);
        if (retry.stop === 'refusal' || retry.stop === 'max_tokens') {
          return { ...retry, usage, raw: jsonRaw(retry), mode: 'json' };
        }
        const again = parseJsonReply(retry.text, req.tools);
        // Keep the repaired reply when it is at least as good; the loop answers what is still invalid.
        if (again.calls.length || !parsed.calls.length) {
          reply = retry;
          parsed = again;
        }
      }
      // Ids are deterministic, so a replayed run sends the same requests.
      const turnNo = req.messages.filter((m) => m.role === 'assistant').length;
      const toolCalls: ToolCall[] = parsed.calls.map((c, i) => ({
        id: `json_${turnNo}_${i}`,
        name: c.name,
        input: c.input,
      }));
      return {
        stop: toolCalls.length ? 'tool_use' : reply.stop,
        text: reply.text,
        toolCalls,
        raw: jsonRaw(reply),
        usage,
        model: reply.model,
        mode: 'json',
      };
    },
  };
}
