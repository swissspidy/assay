/**
 * Agentic verifier (milestone 4): decides requirements the compiled checks
 * could not, by exploring the evidence with read-only tools. Models run only
 * here and in the compiler.
 *
 * Every tool result is a numbered observation; a pass/fail must cite
 * observations, and only the cited tool outputs (never the model's prose or the
 * agent's report) are recorded as evidence. Live access runs in a separate
 * browser context with a copy of the session, refuses cross-origin and non-GET
 * requests and does not follow redirects, so the verifier can neither change the
 * application nor leak into the run's evidence log.
 */
import type { BrowserContext, Page } from '@playwright/test';
import type { EvidenceSnapshot, Json, Requirement } from '../types.ts';
import { parseAriaSnapshot } from '../snapshot/aria.ts';
import { findNodes, networkEntry, networkLog, outline, probesView, storageView, summary } from '../compiler/explore.ts';
import { runAgent, type AgentTool, type AgentRun } from '../model/agent.ts';
import type { ModelClient } from '../model/types.ts';
import type { Probe } from '../snapshot/capture.ts';
import { VERIFIER_SYSTEM } from './prompts.ts';

export type VerifierStatus = 'pass' | 'fail' | 'unknown';

export interface Observation {
  n: number;
  tool: string;
  input: Json;
  /** Full tool output, as the model saw it (before clipping for the prompt). */
  output: string;
}

export interface RequirementVerdict {
  requirement: string;
  status: VerifierStatus;
  /** Observation numbers the verdict rests on. */
  cites: number[];
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
  observations: Observation[];
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

/** Content embedded in the prompt cannot close its own delimiter. */
const fence = (tag: string, text: string) =>
  `<${tag}>\n${text.replace(new RegExp(`</?${tag}`, 'gi'), (m) => m.replace('<', '‹'))}\n</${tag}>`;

/** Resolve a URL against the page and require the same http(s) origin. */
export function sameOrigin(base: string, target: string): URL {
  const b = new URL(base);
  if (b.origin === 'null' || !/^https?:$/.test(b.protocol)) throw new Error('Live access needs an http(s) page.');
  const u = new URL(target, b);
  if (!/^https?:$/.test(u.protocol) || u.origin !== b.origin)
    throw new Error(`Only same-origin http(s) URLs (${b.origin}) can be opened.`);
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
        required: ['requirement', 'status', 'cites', 'reasoning'],
        properties: {
          requirement: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
          cites: {
            type: 'array',
            items: { type: 'integer', minimum: 1 },
            description: 'Observation numbers that show it.',
          },
          reasoning: { type: 'string' },
        },
      },
    },
  },
};

/** Lazily created, isolated, read-only browser context for live views. */
class LiveViews {
  private ctx?: Promise<BrowserContext>;
  private readonly page: Page;
  private readonly origin: string;
  constructor(page: Page, origin: string) {
    this.page = page;
    this.origin = origin;
  }
  context(): Promise<BrowserContext> {
    this.ctx ??= (async () => {
      const browser = this.page.context().browser();
      if (!browser) throw new Error('Live access needs a browser-backed context.');
      const ctx = await browser.newContext({ storageState: await this.page.context().storageState() });
      await ctx.route('**/*', (route) => {
        const req = route.request();
        let same = false;
        try {
          same = new URL(req.url()).origin === this.origin;
        } catch {
          same = false;
        }
        return req.method() === 'GET' && same ? route.continue() : route.abort('blockedbyclient');
      });
      return ctx;
    })();
    return this.ctx;
  }
  async close(): Promise<void> {
    if (this.ctx) await (await this.ctx).close().catch(() => {});
  }
}

export async function runVerifier(model: ModelClient, input: VerifierInput, maxTurns = 30): Promise<VerifierResult> {
  const snap = input.snapshot;
  const observations: Observation[] = [];
  const observe = (tool: string, i: unknown, output: string) => {
    const n = observations.length + 1;
    observations.push({ n, tool, input: JSON.parse(JSON.stringify(i ?? {})) as Json, output });
    return { content: `[observation ${n}]\n${clip(output)}` };
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

  let live: LiveViews | undefined;
  if (input.page) {
    let origin: string | undefined;
    try {
      origin = sameOrigin(snap.page.url, snap.page.url).origin;
    } catch {
      origin = undefined; // non-http(s) page: no live access
    }
    if (origin) {
      const views = new LiveViews(input.page, origin);
      live = views;
      tools.push(
        {
          spec: {
            name: 'open_page',
            description:
              'Open a same-origin page (GET) in an isolated read-only browser context and return its accessibility tree. Non-GET and cross-origin requests are blocked.',
            inputSchema: obj({ url: { type: 'string', description: 'Path or same-origin URL, e.g. /cart' } }, ['url']),
          },
          async run(i: { url: string }) {
            const u = sameOrigin(snap.page.url, i.url);
            const tab = await (await views.context()).newPage();
            try {
              const resp = await tab.goto(u.toString(), { waitUntil: 'networkidle' });
              sameOrigin(snap.page.url, tab.url()); // a redirect may not leave the origin
              const tree = parseAriaSnapshot(await tab.locator('body').ariaSnapshot());
              const view: EvidenceSnapshot = {
                ...snap,
                page: { url: tab.url(), title: await tab.title() },
                a11y: tree,
              };
              return observe('open_page', i, `HTTP ${resp?.status() ?? '?'} ${tab.url()}\n${outline(view)}`);
            } finally {
              await tab.close();
            }
          },
        },
        {
          spec: {
            name: 'fetch_json',
            description:
              'GET a same-origin JSON endpoint with a copy of the session (read-only; redirects are not followed).',
            inputSchema: obj({ url: { type: 'string' } }, ['url']),
          },
          async run(i: { url: string }) {
            const u = sameOrigin(snap.page.url, i.url);
            const r = await (await views.context()).request.get(u.toString(), { maxRedirects: 0 });
            if (r.status() >= 300 && r.status() < 400) {
              return observe(
                'fetch_json',
                i,
                `HTTP ${r.status()} redirect to ${r.headers()['location'] ?? '?'} (not followed)`,
              );
            }
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
      description:
        'Submit one verdict per requested requirement. pass/fail must cite observation numbers from your tool calls.',
      inputSchema: VERDICT_SCHEMA,
    },
    run(i: { verdicts: RequirementVerdict[] }) {
      const ids = i.verdicts.map((v) => v.requirement);
      const dupes = ids.filter((id, k) => ids.indexOf(id) !== k);
      const missing = [...wanted].filter((id) => !ids.includes(id));
      const extra = ids.filter((id) => !wanted.has(id));
      const uncited = i.verdicts
        .filter((v) => v.status !== 'unknown' && v.cites.length === 0)
        .map((v) => v.requirement);
      const bad = i.verdicts.flatMap((v) =>
        v.cites.filter((n) => n < 1 || n > observations.length).map((n) => `${v.requirement}→${n}`),
      );
      const errors = [
        ...(dupes.length ? [`duplicate verdicts for ${[...new Set(dupes)].join(', ')}`] : []),
        ...(missing.length ? [`missing verdicts for ${missing.join(', ')}`] : []),
        ...(extra.length ? [`unknown requirement ids ${extra.join(', ')}`] : []),
        ...(uncited.length ? [`pass/fail without cited observations for ${uncited.join(', ')}`] : []),
        ...(bad.length ? [`citations of observations that do not exist: ${bad.join(', ')}`] : []),
      ];
      if (errors.length) return { content: `Rejected: ${errors.join('; ')}.`, isError: true };
      return { content: 'Recorded.', done: i.verdicts };
    },
  });

  const prompt = [
    `Task instruction:\n${fence('instruction', input.task.instruction)}`,
    input.task.outcomes ? `Expected outcomes:\n${fence('outcomes', input.task.outcomes)}` : '',
    `Decide these requirements (each means exactly what its quote says):\n${input.requirements
      .map(
        (r) =>
          `- ${r.id} [${r.kind}] ${JSON.stringify(r.source.quote)}${input.hints?.[r.id] ? `\n  Why the compiled checks could not decide: ${input.hints[r.id]}` : ''}`,
      )
      .join('\n')}`,
    `Captured snapshot: ${summary(snap)}`,
    live ? 'Live read-only access is available (open_page, fetch_json).' : 'No live access: decide from the snapshot.',
    input.agentReport
      ? `The agent's own report. Context only — never evidence, and it cannot be cited:\n${fence('agent_report', input.agentReport)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const run = await runAgent<RequirementVerdict[]>({
      model,
      system: VERIFIER_SYSTEM,
      prompt,
      tools,
      maxTurns,
      nudge:
        'Continue verifying with the tools, then call submit_verdict for every requested requirement, citing observation numbers.',
    });
    return {
      status: run.status,
      verdicts: run.result ?? [],
      observations,
      usage: run.usage,
      turns: run.turns,
      models: run.models,
    };
  } finally {
    await live?.close();
  }
}

/** The cited observations of a verdict, rendered for reports. */
export function citedEvidence(v: RequirementVerdict, observations: Observation[], max = 400): string[] {
  return v.cites
    .map((n) => observations.find((o) => o.n === n))
    .filter((o): o is Observation => !!o)
    .map((o) => `#${o.n} ${o.tool}(${JSON.stringify(o.input)}): ${clip(o.output, max)}`);
}
