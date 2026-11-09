/** The readiness ladder as a table (ADR 0022): one row per task, one column per stage. */
import { styleText } from 'node:util';
import type { StageStatus, StatusResult, StatusStage } from './status.ts';

/** Column headings of the table, per stage. */
export const STAGE_LABELS: Record<StatusStage, string> = {
  valid: 'Valid',
  covered: 'Covered',
  locked: 'Locked',
  stress: 'Stress',
  references: 'References',
  recent: 'Recent',
};

const MARKS: Record<StageStatus, string> = { pass: '✔', fail: '✘', 'not-reached': '–', skipped: '·' };
const STYLES = { pass: 'green', fail: 'red', 'not-reached': 'dim', skipped: 'dim' } as const;

/**
 * The table and a summary line: ✔ passed, ✘ failed, – not reached (an earlier stage failed),
 * · skipped (the stage does not apply to the task, such as no recent runs). The last column is
 * the blocker of the stage that failed. Colour only with `color`; widths never count it.
 */
export function formatStatus(result: StatusResult, opts: { color?: boolean } = {}): string {
  const on = !!opts.color;
  const paint = (style: Parameters<typeof styleText>[0], s: string) =>
    on ? styleText(style, s, { validateStream: false }) : s;
  const names = result.tasks.map((t) => t.name);
  const label = (i: number) =>
    names.indexOf(names[i]!) !== names.lastIndexOf(names[i]!) ? result.tasks[i]!.file : names[i]!;
  const width = Math.max(4, ...result.tasks.map((_, i) => label(i).length));
  const cols = result.stages.map((s) => ({ stage: s, label: STAGE_LABELS[s] }));
  const header = ['Task'.padEnd(width), ...cols.map((c) => c.label), 'Blocker'].join('  ');
  const rule = ['─'.repeat(width), ...cols.map((c) => '─'.repeat(c.label.length)), '─'.repeat(7)].join('  ');
  const lines = [paint('bold', header), rule];
  result.tasks.forEach((t, i) => {
    const cells = cols.map((c) => {
      const st = t.stages[c.stage].status;
      return paint(STYLES[st], MARKS[st]) + ' '.repeat(c.label.length - 1);
    });
    const last = t.ready ? paint('green', 'ready') : (t.blocker ?? '');
    lines.push([label(i).padEnd(width), ...cells, last].join('  ').trimEnd());
  });
  lines.push('', summaryLine(result));
  return lines.join('\n');
}

/** "12 tasks: 7 ready, 3 blocked at locked, 2 at stress". */
export function summaryLine(result: StatusResult): string {
  const { tasks, ready, blocked } = result.summary;
  const parts = [`${ready} ready`];
  Object.entries(blocked).forEach(([stage, n], i) => parts.push(`${n} ${i === 0 ? 'blocked at ' : 'at '}${stage}`));
  return `${tasks} task${tasks === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
