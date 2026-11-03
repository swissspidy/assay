import { parse } from 'yaml';
import type { AXNode, AXStates } from '../types.ts';

/** Roles whose inline `: value` in an aria snapshot is the control's value, not text content. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider', 'combobox']);

/**
 * Parse the YAML produced by Playwright's `locator.ariaSnapshot()` into an AXNode tree.
 * The returned root has role "document".
 */
export function parseAriaSnapshot(yamlText: string): AXNode {
  const doc = parse(yamlText, { schema: 'failsafe' }) as unknown;
  const root: AXNode = { role: 'document', children: [] };
  if (doc == null) return root;
  if (!Array.isArray(doc)) throw new Error('aria snapshot: expected a YAML sequence at top level');
  root.children = parseItems(doc, root);
  if (root.children.length === 0) delete root.children;
  return root;
}

function parseItems(items: unknown[], parent: AXNode): AXNode[] {
  const out: AXNode[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      out.push(parseHeader(item));
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
        if (key.startsWith('/')) {
          // Property of the parent, e.g. "/url: /cart".
          const prop = key.slice(1);
          const v = typeof val === 'string' ? val : String(val ?? '');
          if (prop === 'url') parent.url = v;
          else (parent.props ??= {})[prop] = v;
          continue;
        }
        const node = parseHeader(key);
        if (typeof val === 'string') {
          if (node.role === 'text') node.name = val;
          else if (VALUE_ROLES.has(node.role)) node.value = val;
          else node.children = [{ role: 'text', name: val }];
        } else if (Array.isArray(val)) {
          const children = parseItems(val, node);
          if (children.length) node.children = children;
        }
        out.push(node);
      }
    }
  }
  return out;
}

/** Parse `role "name" [attr] [attr=value]`. */
export function parseHeader(header: string): AXNode {
  let i = 0;
  const s = header.trim();
  while (i < s.length && s[i] !== ' ') i++;
  const node: AXNode = { role: s.slice(0, i) };
  const states: AXStates = {};
  let hasState = false;

  const skipSpaces = () => {
    while (s[i] === ' ') i++;
  };
  skipSpaces();
  if (s[i] === '"') {
    // JSON-style quoted string.
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    node.name = JSON.parse(s.slice(i, j + 1)) as string;
    i = j + 1;
  } else if (s[i] === '/') {
    // Regex name (templates only); keep the source verbatim.
    let j = i + 1;
    while (j < s.length && s[j] !== '/') j += s[j] === '\\' ? 2 : 1;
    node.name = s.slice(i, j + 1);
    i = j + 1;
  }
  for (;;) {
    skipSpaces();
    if (s[i] !== '[') break;
    const end = s.indexOf(']', i);
    if (end < 0) break;
    const attr = s.slice(i + 1, end);
    i = end + 1;
    const eq = attr.indexOf('=');
    const k = eq < 0 ? attr : attr.slice(0, eq);
    const v = eq < 0 ? undefined : attr.slice(eq + 1);
    switch (k) {
      case 'checked':
      case 'pressed':
        states[k] = v === 'mixed' ? 'mixed' : v !== 'false';
        hasState = true;
        break;
      case 'selected':
      case 'expanded':
      case 'disabled':
        states[k] = v !== 'false';
        hasState = true;
        break;
      case 'level':
        node.level = Number(v);
        break;
      case 'ref':
      case 'cursor':
      case 'active':
        break; // volatile, not evidence
      default:
        (node.props ??= {})[k] = v ?? 'true';
    }
  }
  if (hasState) node.states = states;
  return node;
}
