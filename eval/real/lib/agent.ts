/**
 * A plain browser agent for producing evaluation runs: Claude (through the AI SDK
 * adapter, ADR 0007) on Assay's own tool loop, acting on a Playwright page by
 * aria refs. It is deliberately simple, like the agents Assay is meant to check:
 * it sees an accessibility snapshot of the page after every action and reports
 * when it thinks it is done. Its report is never evidence (ADR 0004).
 */
import type { Locator, Page } from '@playwright/test';
import { runAgent, type AgentTool } from '../../../src/model/agent.ts';
import type { ModelClient, ModelRequest } from '../../../src/model/types.ts';

/** Characters of the page snapshot shown per part. */
const PART = 14_000;

export const AGENT_SYSTEM = `You are a web agent operating a real web application in a browser for a user. You are already signed in as the user.

After every action you get the page's URL, title and an accessibility snapshot. Elements carry references like [ref=e12]; pass them to the tools. Long pages are split into parts; use show_part to read the rest. Only earlier snapshots than the latest one are shortened.

Complete the user's task exactly as stated, then call finish with a one-sentence report of what you did. Do not change anything the task does not ask for. If the task cannot be done, call finish and say why.`;

export interface AgentResult {
  status: string;
  report?: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  actions: string[];
  models: string[];
}

/** Shortens every tool result but the newest before the request goes out, so the context stays small. */
export function elidingModel(inner: ModelClient): ModelClient {
  return {
    id: inner.id,
    turn(req: ModelRequest) {
      const lastResults = req.messages.findLastIndex((m) => m.role === 'user' && m.toolResults?.length);
      const messages = req.messages.map((m, i) =>
        m.role === 'user' && m.toolResults && i !== lastResults
          ? {
              ...m,
              toolResults: m.toolResults.map((r) => {
                const cut = r.content.indexOf('\nSnapshot part');
                return { ...r, content: cut > 0 ? `${r.content.slice(0, cut)}\n(snapshot omitted)` : r.content };
              }),
            }
          : m,
      );
      return inner.turn({ ...req, messages });
    },
  };
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

export async function runBrowserAgent(
  page: Page,
  opts: { model: ModelClient; task: string; maxTurns?: number },
): Promise<AgentResult> {
  const origin = new URL(page.url()).origin;
  const actions: string[] = [];
  let parts: string[] = [];

  async function observe(note?: string): Promise<string> {
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    let snap: string;
    try {
      snap = await page.ariaSnapshot({ mode: 'ai' });
    } catch (e) {
      snap = `(snapshot failed: ${e instanceof Error ? e.message : String(e)})`;
    }
    parts = [];
    for (let i = 0; i < snap.length; i += PART) parts.push(snap.slice(i, i + PART));
    if (!parts.length) parts = [''];
    const head = `URL: ${page.url()}\nTitle: ${await page.title().catch(() => '')}${note ? `\n${note}` : ''}`;
    return `${head}\nSnapshot part 1 of ${parts.length}:\n${parts[0]}`;
  }

  const byRef = (ref: string): Locator => page.getByRef(ref);
  const act =
    <I>(name: string, describe: (i: I) => string, fn: (i: I) => Promise<void>) =>
    async (i: I) => {
      actions.push(`${name} ${describe(i)}`);
      try {
        await fn(i);
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
        return { content: await observe(`Action failed: ${msg}`), isError: true };
      }
      return { content: await observe() };
    };

  const refSchema = { type: 'string', description: 'Element reference from the snapshot, e.g. "e12".' };
  type Done = { report: string };
  const tools: AgentTool<Done>[] = [
    {
      spec: {
        name: 'goto',
        description: 'Open a URL of this application (absolute, or a path like /admin).',
        inputSchema: obj({ url: { type: 'string' } }, ['url']),
      },
      run: act<{ url: string }>(
        'goto',
        (i) => i.url,
        async (i) => {
          const u = new URL(i.url, origin);
          if (u.origin !== origin) throw new Error(`only ${origin} can be opened`);
          await page.goto(u.href);
        },
      ),
    },
    {
      spec: {
        name: 'click',
        description: 'Click an element.',
        inputSchema: obj({ ref: refSchema }, ['ref']),
      },
      run: act<{ ref: string }>(
        'click',
        (i) => i.ref,
        async (i) => {
          await byRef(i.ref).click({ timeout: 8000 });
        },
      ),
    },
    {
      spec: {
        name: 'fill',
        description: 'Replace the text of an input or text area. Set submit to press Enter afterwards.',
        inputSchema: obj({ ref: refSchema, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text']),
      },
      run: act<{ ref: string; text: string; submit?: boolean }>(
        'fill',
        (i) => `${i.ref} ${JSON.stringify(i.text)}${i.submit ? ' +Enter' : ''}`,
        async (i) => {
          const l = byRef(i.ref);
          await l.fill(i.text, { timeout: 8000 });
          if (i.submit) await l.press('Enter');
        },
      ),
    },
    {
      spec: {
        name: 'select',
        description: 'Choose option(s) of a select element by label or value.',
        inputSchema: obj({ ref: refSchema, options: { type: 'array', items: { type: 'string' } } }, ['ref', 'options']),
      },
      run: act<{ ref: string; options: string[] }>(
        'select',
        (i) => `${i.ref} ${JSON.stringify(i.options)}`,
        async (i) => {
          const l = byRef(i.ref);
          const values = await l.evaluate(
            (el, wanted) =>
              Array.from((el as HTMLSelectElement).options)
                .filter((o) => wanted.some((w) => w === o.value || w.trim() === o.label.trim()))
                .map((o) => o.value),
            i.options,
          );
          if (!values.length) throw new Error(`no option matches ${JSON.stringify(i.options)}`);
          await l.selectOption(values, { timeout: 8000 });
        },
      ),
    },
    {
      spec: {
        name: 'set_checked',
        description: 'Check or uncheck a checkbox or radio button.',
        inputSchema: obj({ ref: refSchema, checked: { type: 'boolean' } }, ['ref', 'checked']),
      },
      run: act<{ ref: string; checked: boolean }>(
        'set_checked',
        (i) => `${i.ref} ${i.checked}`,
        async (i) => {
          await byRef(i.ref).setChecked(i.checked, { timeout: 8000 });
        },
      ),
    },
    {
      spec: {
        name: 'press',
        description: 'Press a key (e.g. "Enter", "Escape", "Tab"), on an element if ref is given.',
        inputSchema: obj({ key: { type: 'string' }, ref: refSchema }, ['key']),
      },
      run: act<{ key: string; ref?: string }>(
        'press',
        (i) => `${i.key}${i.ref ? ` on ${i.ref}` : ''}`,
        async (i) => {
          if (i.ref) await byRef(i.ref).press(i.key, { timeout: 8000 });
          else await page.keyboard.press(i.key);
        },
      ),
    },
    {
      spec: {
        name: 'back',
        description: 'Go back in the browser history.',
        inputSchema: obj({}, []),
      },
      run: act<Record<string, never>>(
        'back',
        () => '',
        async () => {
          await page.goBack();
        },
      ),
    },
    {
      spec: {
        name: 'wait',
        description: 'Wait for the page to update (1-5 seconds), then show it again.',
        inputSchema: obj({ seconds: { type: 'number' } }, ['seconds']),
      },
      run: act<{ seconds: number }>(
        'wait',
        (i) => String(i.seconds),
        async (i) => {
          await page.waitForTimeout(Math.min(5, Math.max(1, i.seconds)) * 1000);
        },
      ),
    },
    {
      spec: {
        name: 'show_part',
        description: 'Show another part of the latest page snapshot.',
        inputSchema: obj({ part: { type: 'integer' } }, ['part']),
      },
      run: (i: { part: number }) => {
        const p = parts[i.part - 1];
        if (p === undefined) return { content: `There are ${parts.length} parts.`, isError: true };
        return { content: `URL: ${page.url()}\nSnapshot part ${i.part} of ${parts.length}:\n${p}` };
      },
    },
    {
      spec: {
        name: 'finish',
        description: 'End the task with a one-sentence report for the user.',
        inputSchema: obj({ report: { type: 'string' } }, ['report']),
      },
      run: (i: Done) => {
        actions.push(`finish ${JSON.stringify(i.report)}`);
        return { content: 'Done.', done: i };
      },
    },
  ];

  const first = await observe();
  const run = await runAgent<Done>({
    model: elidingModel(opts.model),
    system: AGENT_SYSTEM,
    prompt: `Task: ${opts.task}\n\nThe browser shows:\n${first}`,
    tools,
    maxTurns: opts.maxTurns ?? 30,
    nudge: 'Continue with the tools, and call finish when the task is done.',
  });
  return {
    status: run.status,
    ...(run.result ? { report: run.result.report } : {}),
    steps: run.turns,
    usage: run.usage,
    actions,
    models: run.models,
  };
}
