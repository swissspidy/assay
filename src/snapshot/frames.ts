/**
 * Frame content (ADR 0012). Playwright's aria snapshot shows an iframe as an empty
 * `iframe` node. Each such node gets the content of its frame (same-origin or not) as
 * children, its accessible name and the frame's URL, so locators reach into frames like
 * into any other subtree.
 */
import type { Frame, Locator } from '@playwright/test';
import type { AXNode } from '../types.ts';
import { parseAriaSnapshot } from './aria.ts';

export interface FrameLimits {
  /** Frames nested deeper than this are left empty (default 4). */
  maxDepth: number;
  /** At most this many frames are captured per page (default 32). */
  maxFrames: number;
  /** Max ms to read one frame (default 3000). */
  timeout: number;
}

export const FRAME_LIMITS: FrameLimits = { maxDepth: 4, maxFrames: 32, timeout: 3000 };

/** The `iframe` nodes of a tree, in document order. */
function iframeNodes(tree: AXNode): AXNode[] {
  const out: AXNode[] = [];
  const walk = (n: AXNode) => {
    if (n.role === 'iframe') out.push(n);
    else n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

/** Marks an iframe node whose frame could not be read, so an empty node is not taken for an empty frame. */
function unavailable(n: AXNode): void {
  n.props = { ...n.props, frame: 'unavailable' };
}

/**
 * The frame elements of `frame` that its accessibility tree shows, in document order (CSS
 * order, through open shadow roots), with their accessible names. Whether the tree shows
 * an element is asked of Playwright itself: the aria snapshot of a hidden one is empty.
 */
async function shownFrameElements(frame: Frame, timeout: number): Promise<{ loc: Locator; name: string }[]> {
  const all = frame.locator('iframe, frame');
  const names = await all.evaluateAll((els) =>
    els.map((el) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page, must be self-contained
      const text = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const ids = el.getAttribute('aria-labelledby');
      if (ids) {
        const by = text(
          ids
            .split(/\s+/)
            // An id refers within the iframe's own root: its shadow root, if it is in one.
            .map((id) => {
              const root = el.getRootNode() as Document | ShadowRoot;
              const ref = 'getElementById' in root ? root.getElementById(id) : null;
              return (ref ?? el.ownerDocument.getElementById(id))?.textContent ?? '';
            })
            .join(' '),
        );
        if (by) return by;
      }
      return text(el.getAttribute('aria-label')) || text(el.getAttribute('title'));
    }),
  );
  const shown: { loc: Locator; name: string }[] = [];
  for (const [i, name] of names.entries()) {
    const loc = all.nth(i);
    if ((await loc.ariaSnapshot({ timeout })).trim()) shown.push({ loc, name });
  }
  return shown;
}

/** The `textbox` nodes of a frame's own tree (not inside its iframes) that show no value. */
function blankTextboxes(tree: AXNode): AXNode[] {
  const out: AXNode[] = [];
  const walk = (n: AXNode) => {
    if (n.role === 'textbox' && n.value === undefined && n.name) out.push(n);
    if (n.role !== 'iframe') n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

/**
 * Values of contenteditable textboxes (a rich-text editor's title field). Playwright's aria
 * snapshot gives a value only to inputs and textareas, so a `role="textbox"` contenteditable
 * element shows none. Its text becomes the value of the textbox node with its name, when
 * exactly one such element and one such node have that name; anything else is left alone.
 */
async function fillEditableValues(frame: Frame, tree: AXNode, timeout: number): Promise<void> {
  const blanks = blankTextboxes(tree);
  if (!blanks.length) return;
  const editables = frame.locator('[role="textbox"][contenteditable]:not([contenteditable="false"])');
  const byName = new Map<string, string[]>();
  for (let i = 0, n = await editables.count(); i < n; i++) {
    const loc = editables.nth(i);
    // The name as the aria snapshot computes it; an empty snapshot means the tree does not show it.
    const [node] = parseAriaSnapshot(await loc.ariaSnapshot({ timeout })).children ?? [];
    if (node?.role !== 'textbox' || !node.name) continue;
    const text = await loc.evaluate((el) => (el as HTMLElement).innerText.replace(/\n$/, ''), undefined, { timeout });
    byName.set(node.name, [...(byName.get(node.name) ?? []), text]);
  }
  for (const node of blanks) {
    const values = byName.get(node.name!);
    if (values?.length !== 1 || blanks.filter((b) => b.name === node.name).length !== 1) continue;
    if (values[0]) node.value = values[0];
  }
}

/**
 * Fill the `iframe` nodes of `tree` (the aria snapshot of `frame`) with their frames'
 * content, recursively, and append each captured frame's text to `texts` (document order,
 * a frame before the frames inside it). When the frame elements cannot be paired one to
 * one with the tree's iframe nodes, or a frame cannot be read, the node stays empty and is
 * marked `props.frame: "unavailable"`.
 */
export async function attachFrames(
  frame: Frame,
  tree: AXNode,
  texts: string[],
  limits: FrameLimits = FRAME_LIMITS,
  depth = 0,
  budget = { left: limits.maxFrames },
): Promise<void> {
  try {
    await fillEditableValues(frame, tree, limits.timeout);
  } catch {
    /* values stay as the aria snapshot gave them */
  }
  const slots = iframeNodes(tree);
  if (!slots.length) return;
  let elements: { loc: Locator; name: string }[];
  try {
    elements = await shownFrameElements(frame, limits.timeout);
  } catch {
    slots.forEach(unavailable);
    return;
  }
  // The page changed between the snapshot and the lookup: no pairing can be trusted.
  if (elements.length !== slots.length) {
    slots.forEach(unavailable);
    return;
  }
  for (const [i, slot] of slots.entries()) {
    const { loc, name } = elements[i]!;
    if (name) slot.name = name;
    if (depth >= limits.maxDepth || budget.left <= 0) {
      unavailable(slot);
      continue;
    }
    budget.left--;
    try {
      const handle = await loc.elementHandle({ timeout: limits.timeout });
      const child = await handle.contentFrame();
      await handle.dispose();
      if (!child || child.isDetached()) throw new Error('no frame');
      slot.url = child.url();
      const sub = parseAriaSnapshot(await child.locator('body').ariaSnapshot({ timeout: limits.timeout }));
      const text = await child.evaluate(() => (document.body ? document.body.innerText : ''));
      if (text.trim()) texts.push(text);
      await attachFrames(child, sub, texts, limits, depth + 1, budget);
      if (sub.children?.length) slot.children = sub.children;
    } catch {
      unavailable(slot);
    }
  }
}
