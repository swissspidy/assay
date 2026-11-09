/**
 * `assay bench` output: a terminal table, a Markdown report and JSON. All three come from the
 * result alone (no clock, no paths beyond what it holds), so a replayed bench prints the same
 * bytes every time. The best value in each column is marked with `*` in the terminal and in
 * bold in Markdown, so it does not depend on colour.
 */
import { alignTable } from '../../table.ts';
import { paint } from '../io.ts';
import type { BenchResult, JobResult, ModelResult, ModelSummary, PriceRow, Stat } from './run.ts';

interface Column {
  title: string;
  /** Which way is better; null: not ranked. */
  better: 'max' | 'min' | null;
  get(s: ModelSummary): Stat;
  fmt(x: number): string;
  /** The spread, in the column's unit. */
  spread(x: number): string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fixed = (d: number) => (x: number) => x.toFixed(d);
/** A token count: as is below 1000, else in thousands (`49.0k`). */
export const tokens = (x: number) => (x < 1000 ? String(Math.round(x)) : `${(x / 1000).toFixed(1)}k`);
/** Dollars: four decimals below $1, else two. */
export const usd = (x: number) => `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`;
/** A duration in ms, s or min, whichever reads best. */
export const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;

const none: Stat = { mean: NaN, sd: NaN, n: 0 };

function columns(r: BenchResult): Column[] {
  const cols: Column[] = [
    { title: 'Compiled', better: 'max', get: (s) => s.compiled, fmt: pct, spread: pct },
    // The strategy dimension (ADR 0026): what covered the requirements. Not ranked: more mining is
    // cheaper, not better checks.
    ...(r.discovery
      ? ([
          { title: 'Req. mined', better: null, get: (s) => s.requirementsMined ?? none, fmt: pct, spread: pct },
          {
            title: 'Req. discovered',
            better: null,
            get: (s) => s.requirementsDiscovered ?? none,
            fmt: pct,
            spread: pct,
          },
          { title: 'No discovery', better: null, get: (s) => s.noDiscovery ?? none, fmt: pct, spread: pct },
        ] satisfies Column[])
      : []),
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

/** A row's name in notes: the model, and with the strategy dimension its strategy. */
const rowName = (r: BenchResult, m: ModelResult) =>
  !r.discovery ? m.label : m.discovery === 'mine-only' ? 'mine-only' : `${m.label} · ${m.discovery}`;

/** A row whose cost is unknown because no table lists its model's price (not a mine-only row, not an error). */
const priceUnknown = (m: ModelResult) =>
  !m.error && m.discovery !== 'mine-only' && !Number.isFinite(m.summary.costUsd.mean);

/** Columns before the measured ones: Model (and Discovery), Mode. */
const leading = (r: BenchResult) => (r.discovery ? 3 : 2);

/** The table as cells: one row per model, the best per column marked (only where models differ). */
function grid(r: BenchResult): { head: string[]; rows: Cell[][] } {
  const cols = columns(r);
  const head = ['Model', ...(r.discovery ? ['Discovery'] : []), 'Mode', ...cols.map((c) => c.title)];
  const cellsOf = (m: ModelResult) =>
    cols.map((c) => {
      const s = c.get(m.summary);
      // With prices listed, an unknown price says so rather than pass for a missing measurement.
      if (c.title === 'Cost' && r.prices && priceUnknown(m)) return 'price unknown';
      if (m.error || !Number.isFinite(s.mean)) return '—';
      const shown = s.n > 1 ? `${c.fmt(s.mean)} ±${c.spread(s.sd)}` : c.fmt(s.mean);
      // Measured in only some repeats: say so rather than pass a partial mean off as the whole.
      return s.n < m.summary.repeats ? `${shown} (${s.n}/${m.summary.repeats} runs)` : shown;
    });
  const texts = r.models.map(cellsOf);
  const best = cols.map((c, ci) => {
    if (!c.better) return new Set<number>();
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
    ...(r.discovery ? [{ text: m.discovery ?? 'model', best: false }] : []),
    { text: modeOf(m), best: false },
    ...texts[mi]!.map((text, ci) => ({ text, best: best[ci]!.has(mi) })),
  ]);
  return { head, rows };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function headline(r: BenchResult): string {
  const heldOut = r.tasks.reduce((a, t) => a + t.heldOut, 0);
  if (r.discovery) {
    const models = new Set(r.models.filter((m) => m.discovery !== 'mine-only').map((m) => m.label)).size;
    const n = r.discovery.length;
    return `${plural(models, 'model')} × ${n} discovery ${n === 1 ? 'strategy' : 'strategies'} (${r.discovery.join(', ')}) × ${plural(r.tasks.length, 'task')} × ${plural(r.runs, 'run')}; checks scored on ${plural(heldOut, 'held-out labelled run')}`;
  }
  return `${plural(r.models.length, 'model')} × ${plural(r.tasks.length, 'task')} × ${plural(r.runs, 'run')}; checks scored on ${plural(heldOut, 'held-out labelled run')}`;
}

const LEGEND = [
  'Compiled: tasks compiled. Stress ok: compiled check sets with no stress-test problems.',
  'Bal. acc, False success: the compiled checks on held-out labelled runs (False success: incorrect runs judged success).',
  'Turns, Tokens, Cost and Time (wall time of a compile) are per task.',
];

/** With the strategy dimension (ADR 0026). */
const STRATEGY_LEGEND = [
  'Discovery: how checks were found (ADR 0020); the mine-only row runs no model (deterministic rubric, mining alone).',
  'Compiled is the accept rate: tasks whose checks passed the acceptance gate.',
  "Req. mined, Req. discovered: the rubrics' requirements covered by mined checks and by checks the discovery agent wrote.",
  'No discovery: tasks compiled with no discovery-agent turn.',
];

const legend = (r: BenchResult) => (r.discovery ? [...LEGEND, ...STRATEGY_LEGEND] : LEGEND);

const jobLabel = (j: JobResult, runs: number) =>
  `${j.discovery === 'mine-only' ? 'mine-only' : j.model}${j.discovery && j.discovery !== 'mine-only' ? ` · ${j.discovery}` : ''} · ${j.task}${runs > 1 ? ` · run ${j.run}` : ''}`;

/** A price per million tokens, as given: `$4`, `$0.2`. */
const perM = (x: number | undefined) => (x === undefined ? '—' : `$${x}`);

/** One price as a note: what it is and where it came from, or that it is unknown. */
const priceNote = (p: PriceRow) =>
  p.source === 'unknown'
    ? `Price of ${p.model}: price unknown (in no --prices file, \`bench.prices\` or the built-in list).`
    : `Price of ${p.model}: ${perM(p.input)} in, ${perM(p.output)} out` +
      `${p.cacheRead !== undefined ? `, ${perM(p.cacheRead)} cache read` : ''}` +
      `${p.cacheWrite !== undefined ? `, ${perM(p.cacheWrite)} cache write` : ''}` +
      ` per million tokens (${p.source}: ${p.key}).`;

/** A multi-line reason (a mine-only compile lists every open requirement) on one line. */
const oneLine = (s: string) => s.replace(/:\n- /, ': ').replace(/\n- /g, '; ').replace(/\n/g, ' ');

/** Refused and failed jobs, warnings, and what could not be measured. */
function notes(r: BenchResult, terminal = false): string[] {
  const out: string[] = [];
  if (r.interrupted)
    out.push(
      `Interrupted: ${r.interrupted.finished} of ${r.interrupted.total} compiles finished; these results are partial.`,
    );
  for (const m of r.models) {
    if (m.error) {
      out.push(`${rowName(r, m)}: error: ${m.error}`);
      continue;
    }
    for (const j of m.jobs) {
      if (j.status === 'refused') out.push(`${jobLabel(j, r.runs)}: not compiled: ${oneLine(j.reason ?? '')}`);
      if (j.status === 'error') out.push(`${jobLabel(j, r.runs)}: error: ${j.reason}`);
      for (const w of j.warnings ?? []) out.push(`${jobLabel(j, r.runs)}: ${w}`);
      if (j.stress && !j.stress.clean) out.push(`${jobLabel(j, r.runs)}: stress: ${j.stress.problems.join(', ')}`);
    }
  }
  const replayed = r.models.filter((m) => m.sources.includes('replay')).map((m) => rowName(r, m));
  if (replayed.length) out.push(`Replayed from cassettes: ${replayed.join(', ')}.`);
  const noPrice = r.models.filter(priceUnknown);
  if (noPrice.length && !r.prices)
    out.push(`Cost —: no price listed for ${noPrice.map((m) => m.ids.join(', ') || m.label).join('; ')}.`);
  if (r.prices) {
    if (noPrice.length) out.push(`Cost: price unknown for ${noPrice.map((m) => rowName(r, m)).join(', ')}.`);
    // The Markdown report lists the prices in a table of their own.
    if (terminal) out.push(...r.prices.map(priceNote));
  }
  if (r.models.some((m) => m.discovery === 'mine-only' && !m.error))
    out.push(
      'mine-only: no model, so no turns, tokens or cost; Time — (mining time is left out, so the report replays byte for byte).',
    );
  const noTime = r.models.filter(
    (m) => !m.error && m.discovery !== 'mine-only' && !Number.isFinite(m.summary.wallMs.mean),
  );
  if (noTime.length)
    out.push(`Time —: not recorded for ${noTime.map((m) => rowName(r, m)).join(', ')} (replayed without timings).`);
  for (const m of r.models) {
    const { wallMs, repeats } = m.summary;
    if (m.error || !Number.isFinite(wallMs.mean) || wallMs.n >= repeats) continue;
    const missing = m.jobs
      .filter((j) => j.status !== 'error' && j.wallMs === null)
      .map((j) => `${j.task} · run ${j.run}`);
    if (missing.length)
      out.push(
        `Time: measured in ${wallMs.n} of ${repeats} runs for ${rowName(r, m)}; no timing for ${missing.join(', ')}.`,
      );
  }
  return out;
}

const text = (c: Cell) => c.text + (c.best ? '*' : '');

/** The terminal table, aligned, with `*` on the best value in each column. */
export function formatBench(r: BenchResult, color = false): string {
  const { head, rows } = grid(r);
  const out = [
    paint(color, 'bold', 'assay bench') + `: ${headline(r)}`,
    '',
    ...alignTable(
      head,
      rows.map((row) => row.map(text)),
      {
        align: head.map((_, i) => (i < leading(r) ? 'left' : 'right')),
        style(s, ri, i) {
          const c = rows[ri]![i]!;
          if (i === leading(r) - 1 && c.text === 'error') return paint(color, 'red', s);
          return c.best ? paint(color, 'green', paint(color, 'bold', s)) : s;
        },
      },
    ),
    '',
    `* best in column.${r.runs > 1 ? ' ± is the standard deviation over runs.' : ''}`,
    ...legend(r),
  ];
  const n = notes(r, true);
  if (n.length) out.push('', ...n.map((x) => `${paint(color, 'yellow', '!')} ${x}`));
  return out.join('\n');
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|');

/** The Markdown report (`--out`). */
export function formatBenchMarkdown(r: BenchResult): string {
  const { head, rows } = grid(r);
  const dim = !!r.discovery;
  const out = [
    '# Model bench',
    '',
    `${headline(r)}.${r.escalate ? ' Held-out runs the checks abstained on were escalated to the same model.' : ''}`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map((_, i) => (i < leading(r) ? '---' : '--:')).join('|')}|`,
    ...rows.map((row) => `| ${row.map((c) => (c.best ? `**${mdCell(c.text)}**` : mdCell(c.text))).join(' | ')} |`),
    '',
    `Best in column in **bold**.${r.runs > 1 ? ' ± is the standard deviation over runs.' : ''} ${legend(r).join(' ')}`,
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
    `| Model |${dim ? ' Discovery |' : ''} Task |${r.runs > 1 ? ' Run |' : ''} Result | Stress | Held-out correct |${dim ? ' Requirements |' : ''} Turns | Tokens in / out | Cost | Time |`,
    `|---|${dim ? '---|' : ''}---|${r.runs > 1 ? '--:|' : ''}---|---|--:|${dim ? '---|' : ''}--:|--:|--:|--:|`,
  ];
  for (const m of r.models) {
    for (const j of m.jobs) {
      const correct = j.heldOut.filter((h) => (h.expected === 'success') === (h.verdict === 'success')).length;
      const result = j.status === 'compiled' ? 'compiled' : j.status === 'refused' ? 'not compiled' : 'error';
      const stress = j.stress
        ? `${j.stress.clean ? 'ok' : j.stress.problems.join(', ')} (mutants ${j.stress.mutantsRejected}/${j.stress.mutantsTotal}, variants ${j.stress.variantsAccepted}/${j.stress.variantsTotal})`
        : '—';
      const req = j.requirements;
      const requirements = req ? `${req.mined} mined, ${req.discovered} discovered of ${req.total}` : '—';
      const cost =
        j.costUsd !== null
          ? usd(j.costUsd)
          : r.prices && j.status !== 'error' && j.price !== undefined
            ? 'price unknown'
            : '—';
      out.push(
        `| ${mdCell(m.label)} |${dim ? ` ${m.discovery ?? 'model'} |` : ''} ${mdCell(j.task)} |${r.runs > 1 ? ` ${j.run} |` : ''} ${result} | ${mdCell(stress)} | ${j.status === 'compiled' ? `${correct}/${j.heldOut.length}` : '—'} |${dim ? ` ${requirements} |` : ''} ${j.turns} | ${tokens(j.usage.inputTokens)} / ${tokens(j.usage.outputTokens)} | ${cost} | ${j.wallMs === null ? '—' : duration(j.wallMs)} |`,
      );
    }
  }
  if (r.prices?.length) {
    out.push(
      '',
      '## Prices',
      '',
      'USD per million tokens, by precedence: a `--prices` file, then `bench.prices`, then the built-in list.',
      '',
      '| Model | Source | Listed as | Input | Output | Cache read | Cache write |',
      '|---|---|---|--:|--:|--:|--:|',
      ...r.prices.map((p) =>
        p.source === 'unknown'
          ? `| ${mdCell(p.model)} | price unknown | — | — | — | — | — |`
          : `| ${mdCell(p.model)} | ${p.source} | ${mdCell(p.key ?? '')} | ${perM(p.input)} | ${perM(p.output)} | ${perM(p.cacheRead)} | ${perM(p.cacheWrite)} |`,
      ),
    );
  }
  const n = notes(r);
  if (n.length) out.push('', '## Notes', '', ...n.map((x) => `- ${mdCell(x)}`));
  return out.join('\n') + '\n';
}

/** JSON with unmeasured values (NaN) as null. */
export function benchJson(r: BenchResult): string {
  return JSON.stringify(r, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2);
}
