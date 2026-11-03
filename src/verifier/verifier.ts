/**
 * Agentic verifier (milestone 4): decides requirements the compiled checks
 * could not, by exploring the evidence with read-only tools. Models run only
 * here and in the compiler.
 */
import type { Page } from '@playwright/test';
import type { EvidenceSnapshot, Json, Requirement } from '../types.ts';
import { parseAriaSnapshot } from '../snapshot/aria.ts';
import { findNodes, networkEntry, networkLog, outline, probesView, storageView, summary } from '../compiler/explore.ts';
import { runAgent, type AgentTool, type AgentRun } from '../model/agent.ts';
import type { ModelClient } from '../model/types.ts';
import type { Probe } from '../snapshot/capture.ts';
import { VERIFIER_SYSTEM } from './prompts.ts';

export type VerifierStatus = 'pass' | 'fail' | 'unknown';

export interface RequirementVerdict {
  requirement: string;
  status: VerifierStatus;
  evidence: string[];
  reasoning: string;
}

export interface VerifierInput {
  task: { instruction: string; outcomes?: string };
  /** Requirements to decide (usually the ones the checks could not). */
  requirements: Requirement[];
  snapshot: EvidenceSnapshot;
  /** Why the compiled checks could not decide, per requirement (hints, not evidence). */
  hints?: Record<string, string>;
  /** Live, read-only access: same-origin GET views of other pages and JSON endpoints. */
  page?: Page;
  /** Read-only backend probes the verifier may re-run. */
  probes?: Record<string, Probe>;
  /** The agent's own account of what it did. Context only, never evidence. */
  agentReport?: string;
}

export interface VerifierResult {
  status: AgentRun<unknown>['status'];
  verdicts: RequirementVerdict[];
  /** Every observation the verifier made, in order (tool name, input, abbreviated output). */
  observations: { tool: string; input: Json; output: string }[];
  usage: AgentRun<unknown>['usage'];
  turns: number;
  models: string[];
}

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties: props,
  required,
});

function sameOrigin(base: string, target: string): URL {
  const b = new URL(base);
  const u = new URL(target, b);
  if (u.origin !== b.origin) throw new Error(`Only same-origin URLs (${b.origin}) can be opened.`);
  return u;
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement', 'status', 'evidence', 'reasoning'],
        properties: {
          requirement: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
          evidence: { type: 'array', items: { type: 'string' } },
          reasoning: { type: 'string' },
        },
      },
    },
  },
};

export async function runVerifier(model: ModelClient, input: VerifierInput, maxTurns = 30): Promise<VerifierResult> {
  const snap = input.snapshot;
  const observations: VerifierResult['observations'] = [];
  const observe = (tool: string, i: unknown, output: string) => {
    observations.push({ tool, input: JSON.parse(JSON.stringify(i ?? {})) as Json, output: clip(output, 600) });
    return { content: clip(output) };
  };
  const wanted = new Set(input.requirements.map((r) => r.id));

  const tools: AgentTool<RequirementVerdict[]>[] = [
    {
      spec: {
        name: 'page_outline',
        description: 'Accessibility tree of the captured final page.',
        inputSchema: obj({}),
      },
      run: (i: object) => observe('page_outline', i, `${summary(snap)}\n\n${outline(snap)}`),
    },
    {
      spec: {
        name: 'find_nodes',
        description: 'Find nodes in the captured page by role and/or case-insensitive substrings of name or text.',
        inputSchema: obj({ role: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' } }),
      },
      run: (i: { role?: string; name?: string; text?: string }) => observe('find_nodes', i, findNodes(snap, i)),
    },
    {
      spec: {
        name: 'network_log',
        description: 'Requests recorded during the run (document/fetch/XHR unless allTypes).',
        inputSchema: obj({
          method: { type: 'string' },
          pathContains: { type: 'string' },
          allTypes: { type: 'boolean' },
        }),
      },
      run: (i: { method?: string; pathContains?: string; allTypes?: boolean }) =>
        observe('network_log', i, networkLog(snap, i)),
    },
    {
      spec: {
        name: 'network_entry',
        description: 'One recorded request with bodies.',
        inputSchema: obj({ seq: { type: 'integer' } }, ['seq']),
      },
      run: (i: { seq: number }) => observe('network_entry', i, networkEntry(snap, i.seq)),
    },
    {
      spec: { name: 'storage', description: 'Cookies and web storage at capture time.', inputSchema: obj({}) },
      run: (i: object) => observe('storage', i, storageView(snap)),
    },
    {
      spec: { name: 'probes', description: 'Probe results captured with the snapshot.', inputSchema: obj({}) },
      run: (i: object) => observe('probes', i, probesView(snap)),
    },
  ];

  const page = input.page;
  if (page) {
    tools.push(
      {
        spec: {
          name: 'open_page',
          description:
            'Open a same-origin page in a new tab (GET only, read-only: do not use URLs that perform actions) and return its accessibility tree.',
          inputSchema: obj({ url: { type: 'string', description: 'Path or same-origin URL, e.g. /cart' } }, ['url']),
        },
        async run(i: { url: string }) {
          const u = sameOrigin(snap.page.url, i.url);
          const tab = await page.context().newPage();
          try {
            const resp = await tab.goto(u.toString(), { waitUntil: 'networkidle' });
            const tree = parseAriaSnapshot(await tab.locator('body').ariaSnapshot());
            const view: EvidenceSnapshot = { ...snap, page: { url: tab.url(), title: await tab.title() }, a11y: tree };
            return observe('open_page', i, `HTTP ${resp?.status() ?? '?'} ${tab.url()}\n${outline(view)}`);
          } finally {
            await tab.close();
          }
        },
      },
      {
        spec: {
          name: 'fetch_json',
          description: 'GET a same-origin JSON endpoint with the session cookies (read-only).',
          inputSchema: obj({ url: { type: 'string' } }, ['url']),
        },
        async run(i: { url: string }) {
          const u = sameOrigin(snap.page.url, i.url);
          const r = await page.request.get(u.toString());
          const body = await r.text();
          let shown = body;
          try {
            shown = JSON.stringify(JSON.parse(body), null, 1);
          } catch {
            /* not JSON: show as text */
          }
          return observe('fetch_json', i, `HTTP ${r.status()}\n${shown}`);
        },
      },
    );
  }
  if (input.probes && Object.keys(input.probes).length) {
    const probes = input.probes;
    tools.push({
      spec: {
        name: 'run_probe',
        description: `Re-run a read-only backend probe now. Available: ${Object.keys(probes).join(', ')}.`,
        inputSchema: obj({ name: { type: 'string', enum: Object.keys(probes) } }, ['name']),
      },
      async run(i: { name: string }) {
        try {
          return observe('run_probe', i, JSON.stringify(await probes[i.name]!(), null, 1));
        } catch (e) {
          return observe('run_probe', i, `ERROR ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
  }
  tools.push({
    spec: {
      name: 'submit_verdict',
      description: 'Submit one verdict per requested requirement, with cited evidence.',
      inputSchema: VERDICT_SCHEMA,
    },
    run(i: { verdicts: RequirementVerdict[] }) {
      const got = new Set(i.verdicts.map((v) => v.requirement));
      const missing = [...wanted].filter((id) => !got.has(id));
      const extra = [...got].filter((id) => !wanted.has(id));
      const unsupported = i.verdicts
        .filter((v) => v.status !== 'unknown' && v.evidence.length === 0)
        .map((v) => v.requirement);
      const errors = [
        ...(missing.length ? [`missing verdicts for ${missing.join(', ')}`] : []),
        ...(extra.length ? [`unknown requirement ids ${extra.join(', ')}`] : []),
        ...(unsupported.length ? [`pass/fail without cited evidence for ${unsupported.join(', ')}`] : []),
      ];
      if (errors.length) return { content: `Rejected: ${errors.join('; ')}.`, isError: true };
      return { content: 'Recorded.', done: i.verdicts };
    },
  });

  const prompt = [
    `Task instruction:\n<instruction>\n${input.task.instruction}\n</instruction>`,
    input.task.outcomes ? `Expected outcomes:\n<outcomes>\n${input.task.outcomes}\n</outcomes>` : '',
    `Decide these requirements (each means exactly what its quote says):\n${input.requirements
      .map(
        (r) =>
          `- ${r.id} [${r.kind}] ${JSON.stringify(r.source.quote)}${input.hints?.[r.id] ? `\n  Why the compiled checks could not decide: ${input.hints[r.id]}` : ''}`,
      )
      .join('\n')}`,
    `Captured snapshot: ${summary(snap)}`,
    page ? 'Live read-only access is available (open_page, fetch_json).' : 'No live access: decide from the snapshot.',
    input.agentReport
      ? `The agent's own report. Context only — never evidence:\n<agent_report>\n${input.agentReport}\n</agent_report>`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const run = await runAgent<RequirementVerdict[]>({
    model,
    system: VERIFIER_SYSTEM,
    prompt,
    tools,
    maxTurns,
    nudge: 'Continue verifying with the tools, then call submit_verdict for every requested requirement.',
  });
  return {
    status: run.status,
    verdicts: run.result ?? [],
    observations,
    usage: run.usage,
    turns: run.turns,
    models: run.models,
  };
}
