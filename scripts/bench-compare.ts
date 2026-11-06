/**
 * Compares benchmark results (scripts/bench.ts --json) and fails on a regression.
 *
 *   node scripts/bench-compare.ts <current.json> [--base <base.json>] [--baseline bench/baseline.json]
 *                                 [--threshold 1.5] [--baseline-threshold 2] [--summary <file>]
 *
 * A workload fails when its median is slower than:
 * - `--base` (the pull request's base, benched in the same job on the same machine) by more
 *   than `--threshold`, comparing the medians as measured; or, when the base has no number for it,
 * - the committed baseline (another machine, maybe another Node) by more than
 *   `--baseline-threshold`, comparing `normalized` times (median / that run's calibration median,
 *   which cancels most of the machine's speed but adds the calibration loop's own noise).
 * Writes a markdown table to stdout and, with `--summary`, appends it to that file.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

interface Timed {
  name: string;
  kind: 'time';
  items: number;
  item: string;
  medianMs: number;
  p95Ms: number;
  perItemUs: number;
  normalized: number;
  extra?: Record<string, unknown>;
}
interface Sized {
  name: string;
  kind: 'size';
  sections: Record<string, { medianBytes: number; maxBytes: number }>;
}
interface Failed {
  name: string;
  kind: 'error';
  error: string;
}
interface Results {
  env: { node: string; cpu: string };
  calibration: { medianMs: number };
  results: (Timed | Sized | Failed)[];
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const basePath = flag('--base');
const baselinePath = flag('--baseline');
const threshold = Number(flag('--threshold') ?? 1.5);
const baselineThreshold = Number(flag('--baseline-threshold') ?? 2);
const summary = flag('--summary');
const currentPath = args[0];
if (!currentPath) throw new Error('usage: bench-compare.ts <current.json> [--base f] [--baseline f] [--summary f]');

const read = (p: string | undefined): Results | undefined =>
  p && existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Results) : undefined;
const current = read(currentPath);
if (!current) throw new Error(`no results at ${currentPath}`);
const base = read(basePath);
const baseline = read(baselinePath);
const timedOf = (r: Results | undefined, name: string) =>
  r?.results.find((x): x is Timed => x.kind === 'time' && x.name === name);
const sizedOf = (r: Results | undefined) => r?.results.find((x): x is Sized => x.kind === 'size');

const fmt = (x: number | undefined, d = 1) => (x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(d));
const ratio = (x: number | undefined) => (x === undefined ? '–' : `${x.toFixed(2)}×`);

const lines: string[] = [];
const failures: string[] = [];
lines.push(
  '## Benchmarks',
  '',
  `Above 1× is slower. "vs base" compares medians with the base commit benched in this job on this runner; it fails above ${threshold}×. "vs baseline" compares normalized times (median ÷ the run's calibration median) with the committed bench/baseline.json, recorded on another machine; it fails above ${baselineThreshold}×, and only when the base has no number for the workload.`,
  '',
  '| Workload | Items | Median ms | p95 ms | µs per item | Base median ms | vs base | vs baseline | |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---|',
);
for (const r of current.results) {
  if (r.kind === 'error') {
    failures.push(r.name);
    lines.push(`| ${r.name} | | | | | | | | **failed**: ${r.error.replace(/\|/g, '\\|').slice(0, 200)} |`);
    continue;
  }
  if (r.kind !== 'time') continue;
  const b = timedOf(base, r.name);
  const bl = timedOf(baseline, r.name);
  const vsBase = b ? r.medianMs / b.medianMs : undefined;
  const vsBaseline = bl ? r.normalized / bl.normalized : undefined;
  let status = 'ok';
  if (vsBase !== undefined) {
    if (vsBase > threshold) status = `**regressed** (> ${threshold}× base)`;
  } else if (vsBaseline !== undefined) {
    if (vsBaseline > baselineThreshold) status = `**regressed** (> ${baselineThreshold}× baseline)`;
  } else status = 'new';
  if (status.startsWith('**')) failures.push(r.name);
  lines.push(
    `| ${r.name} | ${r.items} ${r.item}s | ${fmt(r.medianMs)} | ${fmt(r.p95Ms)} | ${fmt(r.perItemUs, 0)} | ${fmt(b?.medianMs)} | ${ratio(vsBase)} | ${ratio(vsBaseline)} | ${status} |`,
  );
}
lines.push(
  '',
  `Calibration median: ${fmt(current.calibration.medianMs, 2)} ms (${current.env.node}, ${current.env.cpu})` +
    (base ? `; base ${fmt(base.calibration.medianMs, 2)} ms` : '; base not benched') +
    (baseline
      ? `; baseline ${fmt(baseline.calibration.medianMs, 2)} ms (${baseline.env.node}, ${baseline.env.cpu})`
      : '') +
    '.',
);

// Model efficiency of the replayed compiles: recorded in the cassettes, so it moves only when they are re-recorded.
const compile = timedOf(current, 'compile-replay');
if (compile?.extra) {
  const keys = [
    ['turnsPerCompile', 'Model turns per compile', 2],
    ['inputTokensPerCompile', 'Input tokens per compile', 0],
    ['outputTokensPerCompile', 'Output tokens per compile', 0],
    ['costUsdPerCompile', 'Cost per compile (USD)', 4],
    ['reproduced', 'Compiles reproducing the committed check set', 0],
  ] as const;
  const val = (r: Results | undefined, k: string) => timedOf(r, 'compile-replay')?.extra?.[k] as number | undefined;
  lines.push(
    '',
    '### Compile (replayed)',
    '',
    '| Metric | Current | Base | Baseline |',
    '|---|---:|---:|---:|',
    ...keys.map(
      ([k, label, d]) =>
        `| ${label} | ${fmt(val(current, k), d)} | ${fmt(val(base, k), d)} | ${fmt(val(baseline, k), d)} |`,
    ),
  );
}

const size = sizedOf(current);
if (size) {
  const bl = sizedOf(baseline);
  lines.push(
    '',
    '### Snapshot size (real-app runs, JSON bytes)',
    '',
    '| Section | Median | Max | Baseline median |',
    '|---|---:|---:|---:|',
    ...Object.entries(size.sections).map(
      ([k, s]) => `| ${k} | ${s.medianBytes} | ${s.maxBytes} | ${bl?.sections[k]?.medianBytes ?? '–'} |`,
    ),
  );
}

if (failures.length) lines.push('', `**Regressed:** ${failures.join(', ')}.`);
const md = lines.join('\n') + '\n';
console.log(md);
if (summary) appendFileSync(summary, md);
process.exitCode = failures.length ? 1 : 0;
