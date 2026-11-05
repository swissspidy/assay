import { Ajv, type ValidateFunction } from 'ajv';
import type { ModelClient, ModelMessage, ModelTurn, ToolCall, ToolResult, ToolSpec } from './types.ts';

export interface ToolOutcome<R> {
  content: string;
  isError?: boolean;
  /** Set by a terminal tool (e.g. submit): ends the loop with this result. */
  done?: R;
}

export interface AgentTool<R> {
  spec: ToolSpec;
  run(input: never): ToolOutcome<R> | Promise<ToolOutcome<R>>;
}

export interface AgentOptions<R> {
  model: ModelClient;
  system: string;
  prompt: string;
  tools: AgentTool<R>[];
  /** Maximum model turns (default 40). */
  maxTurns?: number;
  /** Reminders sent when the model ends its turn without finishing (default 2). */
  maxNudges?: number;
  nudge?: string;
  onTurn?: (turn: ModelTurn, index: number) => void;
}

export interface AgentRun<R> {
  status: 'done' | 'max_turns' | 'refusal' | 'max_tokens' | 'gave_up';
  result?: R;
  turns: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  transcript: ModelMessage[];
  models: string[];
}

const ajv = new Ajv({ strict: false, allErrors: true });

/**
 * Provider-neutral tool-use loop. Tool inputs are validated before a tool runs. A tool may
 * replace its `spec` between turns (e.g. to accept more input); every turn sends the
 * current specs and validates against them.
 */
export async function runAgent<R>(opts: AgentOptions<R>): Promise<AgentRun<R>> {
  const byName = new Map(opts.tools.map((t) => [t.spec.name, t] as const));
  const compiled = new WeakMap<object, ValidateFunction>();
  const validators = {
    get(name: string): ValidateFunction | undefined {
      const schema = byName.get(name)?.spec.inputSchema;
      if (!schema) return undefined;
      let v = compiled.get(schema);
      if (!v) compiled.set(schema, (v = ajv.compile(schema)));
      return v;
    },
  };
  // Compile the initial schemas up front, so an invalid one fails before the first turn.
  for (const t of opts.tools) validators.get(t.spec.name);
  const messages: ModelMessage[] = [{ role: 'user', text: opts.prompt }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const models = new Set<string>();
  const maxTurns = opts.maxTurns ?? 40;
  let nudges = opts.maxNudges ?? 2;
  const finish = (status: AgentRun<R>['status'], turns: number, result?: R): AgentRun<R> => ({
    status,
    ...(result !== undefined ? { result } : {}),
    turns,
    usage,
    transcript: messages,
    models: [...models],
  });

  for (let i = 0; i < maxTurns; i++) {
    const turn = await opts.model.turn({ system: opts.system, messages, tools: opts.tools.map((t) => t.spec) });
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.cacheReadTokens += turn.usage.cacheReadTokens ?? 0;
    usage.cacheWriteTokens += turn.usage.cacheWriteTokens ?? 0;
    models.add(turn.model);
    opts.onTurn?.(turn, i);
    // Check the stop reason before running any tool.
    if (turn.stop === 'refusal') return finish('refusal', i + 1);
    if (turn.stop === 'max_tokens') return finish('max_tokens', i + 1);
    const empty = !turn.text && turn.toolCalls.length === 0 && Array.isArray(turn.raw) && turn.raw.length === 0;
    // An empty assistant turn cannot be sent back (providers reject empty content).
    if (!empty) messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw });

    if (turn.toolCalls.length === 0) {
      if (nudges-- <= 0) return finish('gave_up', i + 1);
      messages.push({ role: 'user', text: opts.nudge ?? 'Continue. Use the tools to finish the task.' });
      continue;
    }
    // Run all calls of this turn, return all results in a single user message.
    const results: ToolResult[] = [];
    let done: { value: R } | undefined;
    for (const call of turn.toolCalls) {
      if (done) {
        // The task already finished in this turn; later calls do not run, so their
        // side effects cannot disagree with the accepted result.
        results.push({
          toolCallId: call.id,
          content: 'Not run: an earlier call in this turn finished the task.',
          isError: true,
        });
        continue;
      }
      const out = await runTool(call, byName, validators);
      results.push({ toolCallId: call.id, content: out.content, ...(out.isError ? { isError: true } : {}) });
      if (out.done !== undefined) done = { value: out.done };
    }
    messages.push({ role: 'user', toolResults: results });
    if (done) return finish('done', i + 1, done.value);
  }
  return finish('max_turns', maxTurns);
}

async function runTool<R>(
  call: ToolCall,
  byName: Map<string, AgentTool<R>>,
  validators: { get(name: string): ValidateFunction | undefined },
): Promise<ToolOutcome<R>> {
  const tool = byName.get(call.name);
  if (!tool) return { content: `Unknown tool ${call.name}`, isError: true };
  const validate = validators.get(call.name)!;
  if (!validate(call.input)) {
    return { content: `Invalid input: ${ajv.errorsText(validate.errors, { separator: '; ' })}`, isError: true };
  }
  try {
    return await tool.run(call.input as never);
  } catch (e) {
    return { content: `Tool error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}
