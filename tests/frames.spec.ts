/** Frame content and shadow DOM in snapshots (ADR 0012). */
import { expect } from '@playwright/test';
import { captureSnapshot, test } from '../src/playwright/index.ts';
import { AXIndex } from '../src/runtime/axindex.ts';
import type { AXNode, CheckSet, Assertion } from '../src/index.ts';
import { parseAriaSnapshot } from '../src/snapshot/aria.ts';
import { attachFrames, FRAME_LIMITS } from '../src/snapshot/frames.ts';
import { judge } from './helpers.ts';
import { startSites, type Site } from './support/sites.ts';

let app: Site;
let other: Site;
test.beforeAll(async () => ({ app, other } = await startSites()));
test.afterAll(async () => {
  await app.close();
  await other.close();
});

const find = (root: AXNode, role: string, name?: string): AXNode[] => {
  const idx = new AXIndex(root);
  return idx.all.filter((n) => n.node.role === role && (name === undefined || n.node.name === name)).map((n) => n.node);
};

const checks = (assertions: Assertion[]): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 'frames',
  version: '1',
  task: { instruction: 'Write the post.' },
  requirements: [{ id: 'R1', kind: 'hard', text: 'post', source: { field: 'instruction', quote: 'Write the post' } }],
  checks: assertions.map((assert, i) => ({ id: `C${i + 1}`, requirement: 'R1', description: 'd', assert })),
});

test('same-origin and cross-origin frames are captured under their iframe nodes', async ({ page }) => {
  await page.goto(`${app.origin}/frames`);
  await expect(page.frameLocator('iframe[title="Payment"]').getByRole('button')).toBeVisible();
  await expect(
    page.frameLocator('iframe[title="Editor canvas"]').frameLocator('iframe').getByText('Embedded chart'),
  ).toBeVisible();
  const s = await captureSnapshot(page);

  const iframes = find(s.a11y, 'iframe');
  // The hidden tracking frame is not in the accessibility tree, so it is not captured either.
  expect(iframes.map((f) => f.name)).toEqual(['Editor canvas', 'Embed', 'Payment']);
  const [canvas, embed, payment] = iframes;
  expect(canvas!.url).toBe(`${app.origin}/canvas`);
  expect(payment!.url).toBe(`${other.origin}/widget`);
  expect(embed!.url).toBe(`${other.origin}/embed`);

  // Form state inside the frames: values and checked states.
  expect(find(canvas!, 'textbox', 'Add title')[0]!.value).toBe('Roadmap 2027');
  expect(find(canvas!, 'checkbox', 'Sticky')[0]!.states).toEqual({ checked: true });
  expect(find(payment!, 'textbox', 'Card number')[0]!.value).toBe('4242 4242 4242 4242');
  expect(find(embed!, 'figure')).toHaveLength(1);
  expect(Object.values(canvas!.props ?? {})).not.toContain('unavailable');

  // Their text follows the page's, a frame before the frames inside it.
  expect(s.text.startsWith('Edit post')).toBe(true);
  const at = (t: string) => s.text.indexOf(t);
  expect(at('Status: draft')).toBeLessThan(at('What we plan to build next year.'));
  expect(at('What we plan to build next year.')).toBeLessThan(at('Embedded chart'));
  expect(at('Embedded chart')).toBeLessThan(at('Pay US$21.50'));
});

test('locators descend into frames; an iframe is also a scope', async ({ page }) => {
  await page.goto(`${app.origin}/frames`);
  await expect(page.frameLocator('iframe[title="Payment"]').getByRole('button')).toBeVisible();
  const canvas = { role: 'iframe', name: 'Editor canvas' };
  const cs = checks([
    // Transparent: found from the document like any node.
    { kind: 'state', target: { role: 'textbox', name: 'Add title' }, expect: { value: 'Roadmap 2027' } },
    // Explicit: inside the frame named "Editor canvas".
    {
      kind: 'contains',
      scope: canvas,
      match: { role: 'paragraph', text: { contains: 'plan to build' } },
    },
    { kind: 'state', target: { role: 'checkbox', name: 'Sticky', within: canvas }, expect: { checked: true } },
    // Cross-origin frame content, read as a value.
    {
      kind: 'value',
      source: {
        from: 'node',
        field: 'name',
        target: { role: 'button', within: { role: 'iframe', name: 'Payment' } },
      },
      normalize: [
        { op: 'extract', regex: 'US\\$[\\d.]+' },
        { op: 'currency', locale: 'en-US', currency: 'USD' },
      ],
      expect: { equals: { amount: 21.5, currency: 'USD' } },
    },
    // A frame's URL is the iframe node's url.
    {
      kind: 'value',
      source: { from: 'node', field: 'url', target: canvas },
      expect: { regex: '/canvas$' },
    },
    // Scoped text reads the frame's content.
    {
      kind: 'value',
      source: { from: 'text', scope: { role: 'iframe', name: 'Embed' }, pattern: 'Embedded (\\w+)' },
      expect: { equals: 'chart' },
    },
  ]);
  const { outcome, snapshot } = await judge(page, cs);
  expect(outcome.checks.map((c) => `${c.check}:${c.status}`)).toEqual([
    'C1:pass',
    'C2:pass',
    'C3:pass',
    'C4:pass',
    'C5:pass',
    'C6:pass',
  ]);
  expect(outcome.checks[0]!.evidence[0]!.locator).toBe(
    'main › iframe "Editor canvas" › main "Block editor" › textbox "Add title"',
  );
  // Without frame capture, the frames are empty nodes as before.
  const flat = await captureSnapshot(page, { frames: false });
  expect(find(flat.a11y, 'iframe').every((f) => !f.children && f.name === undefined)).toBe(true);
  expect(flat.text).not.toContain('Embedded chart');
  expect(snapshot.text).toContain('Embedded chart');
});

test('a frame that is not read stays empty and is marked unavailable', async ({ page }) => {
  await page.goto(`${app.origin}/frames`);
  await expect(page.frameLocator('iframe[title="Payment"]').getByRole('button')).toBeVisible();
  const tree = parseAriaSnapshot(await page.locator('body').ariaSnapshot());
  const texts: string[] = [];
  await attachFrames(page.mainFrame(), tree, texts, { ...FRAME_LIMITS, maxFrames: 1 });
  const [canvas] = find(tree, 'iframe', 'Editor canvas');
  const [payment] = find(tree, 'iframe', 'Payment');
  expect(canvas!.children).toBeDefined();
  // Over the budget: named, but not read.
  expect(payment).toMatchObject({ name: 'Payment', props: { frame: 'unavailable' } });
  expect(payment!.children).toBeUndefined();
  // The canvas's own embed was over the budget too.
  expect(find(canvas!, 'iframe', 'Embed')[0]!.props).toEqual({ frame: 'unavailable' });
  expect(texts).toHaveLength(1);
});

test('open shadow roots are captured, slots included; closed ones are not', async ({ page }) => {
  await page.goto(`${app.origin}/shadow`);
  await expect(page.getByRole('button', { name: 'Open shadow button' })).toBeVisible();
  const s = await captureSnapshot(page);
  const card = find(s.a11y, 'region', 'Card');
  expect(card).toHaveLength(1);
  // Slotted light-DOM content sits where its slot is.
  expect(find(card[0]!, 'heading', 'Slotted title')).toHaveLength(1);
  expect(find(card[0]!, 'button', 'Open shadow button')).toHaveLength(1);
  // A shadow root inside a shadow root.
  expect(find(card[0]!, 'spinbutton', 'Quantity')[0]!.value).toBe('3');
  // Closed shadow roots are invisible to the page's own scripts and to Playwright.
  expect(find(s.a11y, 'button', 'Closed shadow button')).toHaveLength(0);

  const { outcome } = await judge(
    page,
    checks([
      {
        kind: 'state',
        target: { role: 'spinbutton', name: 'Quantity', within: { role: 'region', name: 'Card' } },
        expect: { value: '3' },
      },
    ]),
  );
  expect(outcome.verdict).toBe('success');
});
