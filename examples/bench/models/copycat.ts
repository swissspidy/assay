/**
 * A stand-in model for the fixture bench: a custom adapter (ADR 0017) with no tool calling, so
 * Assay drives it in JSON mode. It needs no key and no network. It "knows" the answer: for a
 * tiny-shop task it proposes the handwritten requirements and checks of examples/tiny-shop/tasks.
 * Token counts are estimates (a quarter of the characters), so it has no price.
 *
 * Re-record its cassettes from examples/bench (a `-m` path is relative to the working directory,
 * and this keeps the label the config gives it):
 *   cd examples/bench && node ../../src/cli/index.ts bench -m ./models/copycat.ts --record
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { CheckSet, ModelClient, ModelRequest, ModelTurn } from '../../../src/index.ts';

const TASKS = new URL('../../tiny-shop/tasks/', import.meta.url);
const handwritten: CheckSet[] = readdirSync(TASKS)
  .filter((f) => f.endsWith('.checks.json'))
  .toSorted()
  .map((f) => JSON.parse(readFileSync(new URL(f, TASKS), 'utf8')) as CheckSet);

const estimate = (s: string) => Math.ceil(s.length / 4);

function reply(req: ModelRequest): string {
  const first = req.messages[0];
  const prompt = first?.role === 'user' ? (first.text ?? '') : '';
  const cs = handwritten.find((c) => prompt.includes(`<instruction>\n${c.task.instruction}\n</instruction>`));
  // A second request in one step means the first answer was not accepted: it has nothing better.
  if (!cs || req.messages.length > 1) return 'I have nothing else to propose.';
  if (req.system.includes('submit_rubric')) {
    const requirements = cs.requirements.map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      field: r.source.field,
      quote: r.source.quote,
    }));
    return JSON.stringify({ tool: 'submit_rubric', input: { requirements } });
  }
  return JSON.stringify({ tool: 'submit_checks', input: { checks: cs.checks } });
}

const copycat: ModelClient = {
  id: 'fixture:copycat',
  capabilities: { tools: false },
  async turn(req): Promise<ModelTurn> {
    const text = reply(req);
    return {
      stop: 'end_turn',
      text,
      toolCalls: [],
      raw: [{ type: 'text', text }],
      usage: { inputTokens: estimate(JSON.stringify(req)), outputTokens: estimate(text) },
      model: 'fixture:copycat',
    };
  },
};

export default copycat;
