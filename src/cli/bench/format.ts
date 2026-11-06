/**
 * `assay bench` output: a terminal table, a Markdown report and JSON. All three come from the
 * result alone (no clock, no paths beyond what it holds), so a replayed bench prints the same
 * bytes every time. The best value in each column is marked with `*` in the terminal and in
 * bold in Markdown, so it does not depend on colour.
 */
import { paint } from '../io.ts';
import type { BenchResult, JobResult, ModelResult, ModelSummary, Stat } from './run.ts';

interface Column {
  title: string;
  /** Which way is better; null: not ranked. */
  better: 'max' | 'min';
  get(s: ModelSummary): Stat;
  fmt(x: number): string;
  /** The spread, in the column's unit. */
  spread(x: number): string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fixed = (d: number) => (x: number) => x.toFixed(d);
export const tokens = (x: number) => (x < 1000 ? String(Math.round(x)) : `${(x / 1000).toFixed(1)}k`);
export const usd = (x: number) => `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`;
export const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;

function columns(r: BenchResult): Column[] {
  const cols: Column[] = [
    { title: 'Compiled', better: 'max', get: (s) => s.compiled, fmt: pct, spread: pct },
    { title: 'Stress ok', better: 'max', get: (s) => s.stressClean, fmt: pct, spread: pct },
    { title: 'Bal. acc', better: 'max', get: (s) => s.balancedAccuracy, fmt: fixed(3), spread: fixed(3) },
    { title: 'False success', better: 'min', get: (s) => s.falseSuccess, fmt: pct, spread: pct },
    { title: 'Turns', better: 'min', get: (s) => s.turns, fmt: fixed(1), spread: fixed(1) },
    { title: 'Tokens in', better: 'min', get: (s) => s.inputTokens, fmt: tokens, spread: tokens },
    { title: 'Tokens out', better: 'min', get: (s) => s.outputTokens, fmt: tokens, spread: tokens },
    { title: 'Cost', better: 'min', get: (s) => s.costUsd, fmt: usd, spread: usd },
    { title: 'Time', better: 'min', get: (s) => s.wallMs, fmt: duration, spread: duration },
  ];
  if (r.escalate)
    cols.push({ title: 'Escalated', better: 'min', get: (s) => s.escalated, fmt: fixed(1), spread: fixed(1) });
  return cols;
}

interface Cell {
  text: string;
  best: boolean;
}

const modeOf = (m: ModelResult) => (m.error ? 'error' : m.modes.join('+') || '—');

/** The table as cells: one row per model, the best per column marked (only where models differ). */
function grid(r: BenchResult): { head: string[]; rows: Cell[][] } {
  const cols = columns(r);
  const head = ['Model', 'Mode', ...cols.map((c) => c.title)];
  const cellsOf = (m: ModelResult) =>
    cols.map((c) => {
      const s = c.get(m.summary);
      if (m.error || !Number.isFinite(s.mean)) return '—';
      return s.n > 1 ? `${c.fmt(s.mean)} ±${c.spread(s.sd)}` : c.fmt(s.mean);
    });
  const texts = r.models.map(cellsOf);
  const best = cols.map((c, ci) => {
    // Compare what is shown: a difference too small to display is no difference.
    const shown = r.models
      .map((m, mi) => ({ mi, mean: c.get(m.summary).mean, text: texts[mi]![ci]! }))
      .filter((x) => !r.models[x.mi]!.error && Number.isFinite(x.mean));
    if (shown.length < 2) return new Set<number>();
    const top = shown.reduce((a, b) => ((c.better === 'max' ? b.mean > a.mean : b.mean < a.mean) ? b : a));
    const label = c.fmt(top.mean);
    const winners = shown.filter((x) => c.fmt(x.mean) === label);
    return winners.length === shown.length ? new Set<number>() : new Set(winners.map((x) => x.mi));
  });
  const rows = r.models.map((m, mi) => [
    { text: m.label, best: false },
    { text: modeOf(m), best: false },
    ...texts[mi]!.map((text, ci) => ({ text, best: best[ci]!.has(mi) })),
  ]);
  return { head, rows };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function headline(r: BenchResult): string {
  const heldOut = r.tasks.reduce((a, t) => a + t.heldOut, 0);
  return `${plural(r.models.length, 'model')} × ${plural(r.tasks.length, 'task')} × ${plural(r.runs, 'run')}; checks scored on ${plural(heldOut, 'held-out labelled run')}`;
}

const LEGEND = [
  'Compiled: tasks compiled. Stress ok: compiled check sets with no stress-test problems.',
  'Bal. acc, False success: the compiled checks on held-out labelled runs (False success: incorrect runs judged success).',
  'Turns, Tokens, Cost and Time (wall time of a compile) are per task.',
];

const jobLabel = (j: JobResult, runs: number) => `${j.model} · ${j.task}${runs > 1 ? ` · run ${j.run}` : ''}`;

/** Refused and failed jobs, warnings, and what could not be measured. */
function notes(r: BenchResult): string[] {
  const out: string[] = [];
  if (r.interrupted)
    out.push(
      `Interrupted: ${r.interrupted.finished} of ${r.interrupted.total} compiles finished; these results are partial.`,
    );
  for (const m of r.models) {
    if (m.error) {
      out.push(`${m.label}: error: ${m.error}`);
      continue;
    }
    for (const j of m.jobs) {
      if (j.status === 'refused') out.push(`${jobLabel(j, r.runs)}: not compiled: ${j.reason}`);
      if (j.status === 'error') out.push(`${jobLabel(j, r.runs)}: error: ${j.reason}`);
      for (const w of j.warnings ?? []) out.push(`${jobLabel(j, r.runs)}: ${w}`);
      if (j.stress && !j.stress.clean) out.push(`${jobLabel(j, r.runs)}: stress: ${j.stress.problems.join(', ')}`);
    }
  }
  const replayed = r.models.filter((m) => m.sources.includes('replay')).map((m) => m.label);
  if (replayed.length) out.push(`Replayed from cassettes: ${replayed.join(', ')}.`);
  const noPrice = r.models.filter((m) => !m.error && !Number.isFinite(m.summary.costUsd.mean));
  if (noPrice.length)
    out.push(`Cost —: no price listed for ${noPrice.map((m) => m.ids.join(', ') || m.label).join('; ')}.`);
  const noTime = r.models.filter((m) => !m.error && !Number.isFinite(m.summary.wallMs.mean));
  if (noTime.length)
    out.push(`Time —: not recorded for ${noTime.map((m) => m.label).join(', ')} (replayed without timings).`);
  return out;
}

const text = (c: Cell) => c.text + (c.best ? '*' : '');
const line = (cells: string[]) => cells.join('  ').trimEnd();

/** The terminal table, aligned, with `*` on the best value in each column. */
export function formatBench(r: BenchResult, color = false): string {
  const { head, rows } = grid(r);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((row) => text(row[i]!).length)));
  const pad = (s: string, i: number) => (i < 2 ? s.padEnd(width[i]!) : s.padStart(width[i]!));
  const out = [
    paint(color, 'bold', 'assay bench') + `: ${headline(r)}`,
    '',
    line(head.map(pad)),
    line(width.map((w) => '─'.repeat(w))),
    ...rows.map((row) =>
      line(
        row.map((c, i) => {
          const s = pad(text(c), i);
          if (i === 1 && c.text === 'error') return paint(color, 'red', s);
          return c.best ? paint(color, 'green', paint(color, 'bold', s)) : s;
        }),
      ),
    ),
    '',
    `* best in column.${r.runs > 1 ? ' ± is the standard deviation over runs.' : ''}`,
    ...LEGEND,
  ];
  const n = notes(r);
  if (n.length) out.push('', ...n.map((x) => `${paint(color, 'yellow', '!')} ${x}`));
  return out.join('\n');
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|');

/** The Markdown report (`--out`). */
export function formatBenchMarkdown(r: BenchResult): string {
  const { head, rows } = grid(r);
  const out = [
    '# Model bench',
    '',
    `${headline(r)}.${r.escalate ? ' Held-out runs the checks abstained on were escalated to the same model.' : ''}`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map((_, i) => (i < 2 ? '---' : '--:')).join('|')}|`,
    ...rows.map((row) => `| ${row.map((c) => (c.best ? `**${mdCell(c.text)}**` : mdCell(c.text))).join(' | ')} |`),
    '',
    `Best in column in **bold**.${r.runs > 1 ? ' ± is the standard deviation over runs.' : ''} ${LEGEND.join(' ')}`,
    '',
    '## Tasks',
    '',
    '| Task | File | Compiled from | Held-out runs |',
    '|---|---|---|--:|',
    ...r.tasks.map(
      (t) => `| ${mdCell(t.name)} | ${mdCell(t.file)} | ${mdCell(t.training.join(', '))} | ${t.heldOut} |`,
    ),
    '',
    '## Per task',
    '',
    `| Model | Task |${r.runs > 1 ? ' Run |' : ''} Result | Stress | Held-out correct | Turns | Tokens in / out | Cost | Time |`,
    `|---|---|${r.runs > 1 ? '--:|' : ''}---|---|--:|--:|--:|--:|--:|`,
  ];
  for (const m of r.models) {
    for (const j of m.jobs) {
      const correct = j.heldOut.filter((h) => (h.expected === 'success') === (h.verdict === 'success')).length;
      const result = j.status === 'compiled' ? 'compiled' : j.status === 'refused' ? 'not compiled' : 'error';
      const stress = j.stress
        ? `${j.stress.clean ? 'ok' : j.stress.problems.join(', ')} (mutants ${j.stress.mutantsRejected}/${j.stress.mutantsTotal}, variants ${j.stress.variantsAccepted}/${j.stress.variantsTotal})`
        : '—';
      out.push(
        `| ${mdCell(m.label)} | ${mdCell(j.task)} |${r.runs > 1 ? ` ${j.run} |` : ''} ${result} | ${mdCell(stress)} | ${j.status === 'compiled' ? `${correct}/${j.heldOut.length}` : '—'} | ${j.turns} | ${tokens(j.usage.inputTokens)} / ${tokens(j.usage.outputTokens)} | ${j.costUsd === null ? '—' : usd(j.costUsd)} | ${j.wallMs === null ? '—' : duration(j.wallMs)} |`,
      );
    }
  }
  const n = notes(r);
  if (n.length) out.push('', '## Notes', '', ...n.map((x) => `- ${mdCell(x)}`));
  return out.join('\n') + '\n';
}

/** JSON with unmeasured values (NaN) as null. */
export function benchJson(r: BenchResult): string {
  return JSON.stringify(r, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2);
}
