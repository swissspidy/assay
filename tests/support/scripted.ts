import type { ModelClient, ModelRequest, ModelTurn } from '../../src/index.ts';

/** A fake model that plays a fixed script; each step sees the request (to inspect tool results). */
export function scripted(
  steps: ((req: ModelRequest) => Partial<ModelTurn>)[],
): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  return {
    id: 'scripted:test',
    requests,
    async turn(req) {
      requests.push(structuredClone(req));
      const step = steps[i++];
      if (!step) throw new Error('script exhausted');
      const t = step(req);
      const toolCalls = t.toolCalls ?? [];
      return {
        stop: t.stop ?? (toolCalls.length ? 'tool_use' : 'end_turn'),
        text: t.text ?? '',
        toolCalls,
        raw: t.raw ?? [{ type: 'scripted', n: i }],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'scripted:test',
      };
    },
  };
}

export const call = (name: string, input: unknown, id = `${name}-${Math.random().toString(36).slice(2, 8)}`) => ({
  toolCalls: [{ id, name, input }],
});
export const lastResults = (req: ModelRequest) => {
  const m = req.messages.at(-1)!;
  return m.role === 'user' ? (m.toolResults ?? []) : [];
};
