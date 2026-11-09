/**
 * Aligned plain-text tables for terminal output (`assay bench`, `assay gate`): a header, a rule
 * of `─`, then one line per row; columns two spaces apart, trailing spaces trimmed. Widths come
 * from the text without colour, so colouring a cell (`style`) never breaks the alignment.
 */

export type Align = 'left' | 'right';

export interface TableOptions {
  /** Per column; default left. */
  align?: Align[];
  /** Colour or mark a padded cell (row index, column index); default: as is. */
  style?(padded: string, row: number, col: number): string;
}

const line = (cells: string[]) => cells.join('  ').trimEnd();

/** The table's lines: header, rule, rows. */
export function alignTable(head: string[], rows: string[][], opts: TableOptions = {}): string[] {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)));
  const pad = (s: string, i: number) => (opts.align?.[i] === 'right' ? s.padStart(width[i]!) : s.padEnd(width[i]!));
  return [
    line(head.map(pad)),
    line(width.map((w) => '─'.repeat(w))),
    ...rows.map((row, ri) =>
      line(
        row.map((c, i) => {
          const s = pad(c, i);
          return opts.style ? opts.style(s, ri, i) : s;
        }),
      ),
    ),
  ];
}
