/**
 * A small document model for the review sheet and check set diffs, rendered as Markdown
 * (terminal, PR comments) or HTML. Text from the check set is untrusted: it is kept on
 * one line, and escaped so it cannot add headings, lists or markup.
 */

/** A run of text; `b` bold, `code` monospace. */
export type Span = string | { t: string; b?: true; code?: true };
export type Inline = Span | Span[];

export interface ListItem {
  text: Inline;
  items?: ListItem[];
}

export type Block =
  | { h: 1 | 2 | 3; text: Inline }
  | { p: Inline }
  | { quote: string[] }
  | { ul: ListItem[] }
  /** Collapsed on GitHub (`<details>`), shown as a heading elsewhere. */
  | { details: Inline; blocks: Block[] };

export type DocFormat = 'markdown' | 'html';

/** One line: a line break in untrusted text could forge a heading or another entry. */
export const oneLine = (s: string) => s.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');

const spans = (i: Inline): Span[] => (Array.isArray(i) ? i : [i]);

/** Join inline runs. */
export const cat = (...parts: Inline[]): Span[] => parts.flatMap(spans);

// Markdown: only angle brackets are escaped (HTML in a PR comment); the rest stays readable in a terminal.
const mdText = (s: string) => oneLine(s).replace(/[<>]/g, (c) => `\\${c}`);
const mdCode = (s: string) => {
  const t = oneLine(s);
  const fence = '`'.repeat(Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${fence}${fence.length > 1 || t.startsWith('`') || t.endsWith('`') ? ` ${t} ` : t}${fence}`;
};

function mdInline(i: Inline): string {
  return spans(i)
    .map((s) => {
      if (typeof s === 'string') return mdText(s);
      const t = s.code ? mdCode(s.t) : mdText(s.t);
      return s.b ? `**${t}**` : t;
    })
    .join('');
}

function mdList(items: ListItem[], depth: number): string[] {
  return items.flatMap((it) => [
    `${'  '.repeat(depth)}- ${mdInline(it.text)}`,
    ...(it.items ? mdList(it.items, depth + 1) : []),
  ]);
}

function markdown(blocks: Block[], details: boolean): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (out.length) out.push('');
    if ('h' in b) out.push(`${'#'.repeat(b.h)} ${mdInline(b.text)}`);
    else if ('p' in b) out.push(mdInline(b.p));
    else if ('quote' in b) out.push(...b.quote.map((l) => `> ${mdText(l)}`));
    else if ('ul' in b) out.push(...mdList(b.ul, 0));
    else if (details) {
      out.push(
        `<details><summary>${htmlInline(b.details)}</summary>`,
        '',
        ...markdown(b.blocks, details),
        '',
        '</details>',
      );
    } else out.push(`### ${mdInline(b.details)}`, '', ...markdown(b.blocks, details));
  }
  return out;
}

const esc = (s: string) =>
  oneLine(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function htmlInline(i: Inline): string {
  return spans(i)
    .map((s) => {
      if (typeof s === 'string') return esc(s);
      const t = s.code ? `<code>${esc(s.t)}</code>` : esc(s.t);
      return s.b ? `<strong>${t}</strong>` : t;
    })
    .join('');
}

function htmlList(items: ListItem[]): string {
  return `<ul>${items.map((it) => `<li>${htmlInline(it.text)}${it.items ? htmlList(it.items) : ''}</li>`).join('')}</ul>`;
}

function html(blocks: Block[]): string[] {
  return blocks.map((b) => {
    if ('h' in b) return `<h${b.h}>${htmlInline(b.text)}</h${b.h}>`;
    if ('p' in b) return `<p>${htmlInline(b.p)}</p>`;
    if ('quote' in b) return `<blockquote>${b.quote.map(esc).join('<br>')}</blockquote>`;
    if ('ul' in b) return htmlList(b.ul);
    return `<details><summary>${htmlInline(b.details)}</summary>\n${html(b.blocks).join('\n')}\n</details>`;
  });
}

/**
 * Render blocks. Markdown shows `details` blocks as headings unless `details` is set
 * (a GitHub comment collapses them).
 */
export function render(blocks: Block[], format: DocFormat = 'markdown', opts: { details?: boolean } = {}): string {
  return format === 'html' ? html(blocks).join('\n') : markdown(blocks, !!opts.details).join('\n');
}
