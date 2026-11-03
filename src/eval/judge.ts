/**
 * LLM-judge baseline (milestone 5): one judgment per trajectory (a call, retried only for an
 * invalid reply) that sees what a
 * typical judge sees — the task, the final page (accessibility outline, text, URL)
 * and the agent's own report — and returns success or fail. It does not explore.
 */
import type { EvidenceSnapshot } from '../types.ts';
import { outline } from '../compiler/explore.ts';
import { runAgent, type AgentRun } from '../model/agent.ts';
import type { ModelClient } from '../model/types.ts';

export interface JudgeInput {
  task: { instruction: string; outcomes?: string };
  snapshot: EvidenceSnapshot;
  agentReport?: string;
}

export interface JudgeResult {
  verdict: 'success' | 'fail' | 'abstain';
  reasoning: string;
  /** `error`: the model call failed (recorded, counted as abstain). */
  status: AgentRun<unknown>['status'] | 'error';
  usage: AgentRun<unknown>['usage'];
  models: string[];
}

export const JUDGE_SYSTEM = `You judge whether a web agent completed a task, from the final state of the page. Answer with submit_judgment: "success" if the task's outcomes were achieved, otherwise "fail". Give a one-paragraph reason.`;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export async function llmJudge(model: ModelClient, input: JudgeInput): Promise<JudgeResult> {
  const s = input.snapshot;
  const prompt = [
    `Task: ${input.task.instruction}`,
    input.task.outcomes ? `Expected outcomes:\n${input.task.outcomes}` : '',
    `Final page: ${s.page.url} — ${JSON.stringify(s.page.title)}`,
    `Accessibility tree:\n${outline(s, 200)}`,
    `Visible text:\n${clip(s.text, 3000)}`,
    input.agentReport ? `The agent reported: ${input.agentReport}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  let run;
  try {
    run = await runAgent<{ verdict: 'success' | 'fail'; reasoning: string }>({
      model,
      system: JUDGE_SYSTEM,
      prompt,
      maxTurns: 3,
      tools: [
        {
          spec: {
            name: 'submit_judgment',
            description: 'Submit the judgment.',
            strict: true,
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['verdict', 'reasoning'],
              properties: { verdict: { type: 'string', enum: ['success', 'fail'] }, reasoning: { type: 'string' } },
            },
          },
          run: (i: { verdict: 'success' | 'fail'; reasoning: string }) => ({ content: 'Recorded.', done: i }),
        },
      ],
    });
  } catch (e) {
    return {
      verdict: 'abstain',
      reasoning: `model error: ${e instanceof Error ? e.message : String(e)}`,
      status: 'error',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      models: [model.id],
    };
  }
  return {
    verdict: run.result?.verdict ?? 'abstain',
    reasoning: run.result?.reasoning ?? `no judgment (${run.status})`,
    status: run.status,
    usage: run.usage,
    models: run.models,
  };
}
