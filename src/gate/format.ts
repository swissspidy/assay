/**
 * `assay gate` output (ADR 0021): a terminal table, a Markdown report for a pull request comment,
 * and JSON. All three come from the result alone (no clock, paths as the result holds them), so
 * the same runs print the same bytes.
 */
import { styleText } from 'node:util';
import type { Json } from '../types.ts';
import { alignTable } from '../table.ts';
import type {
  GateCounts,
  GateEvidence,
  GateFinding,
  GateRequirement,
  GateResult,
  GateStatus,
  GateTask,
} from './gate.ts';

type Style = 'red' | 'green' | 'yellow' | 'bold' | 'dim';
const paint = (on: boolean, style: Style, text: string) =>
  on ? styleText(style, text, { validateStream: false }) : text;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const count = (c: GateCounts | null) => (c ? `${c.pass}/${c.runs}` : '—');
const change = (b: GateCounts | null, c: GateCounts | null) => `${count(b)} → ${count(c)}`;

/** The task's mark: ✘ blocks, ! regressed but allowed, ✔ improved, + new, · unchanged. */
function mark(t: GateTask): string {
  if (t.blocking) return '✘';
  if (t.allowed) return '!';
  return { improved: '✔', new: '+', unchanged: '·', regressed: '✘', missing: '✘' }[t.status];
}

const markStyle = (m: string): Style => (m === '✘' ? 'red' : m === '!' ? 'yellow' : m === '✔' ? 'green' : 'dim');

/** The requirements that changed, `R1 2/2 → 1/2`, allowed ones marked. */
function changedRequirements(t: GateTask): string {
  if (t.status === 'new' || t.status === 'missing') return '—';
  const moved = t.requirements.filter((r) => r.status === 'regressed' || r.status === 'improved');
  if (!moved.length) return '';
  return moved
    .map(
      (r) => `${r.id} ${change(r.baseline, r.candidate)}${r.status === 'regressed' && r.allowed ? ' (allowed)' : ''}`,
    )
    .join(', ');
}

const statusText = (t: GateTask) => (t.allowed ? `${t.status} (allowed)` : t.status);

function headline(r: GateResult): string {
  return `${plural(r.summary.tasks, 'task')}; baseline ${plural(r.baseline.runs, 'run')}, candidate ${plural(r.candidate.runs, 'run')}; tolerance ${plural(r.tolerance, 'run')}`;
}

function tally(r: GateResult): string {
  const s = r.summary;
  const parts = (['regressed', 'missing', 'improved', 'new', 'unchanged'] as GateStatus[])
    .filter((k) => s[k] > 0)
    .map((k) => `${s[k]} ${k}`);
  return parts.join(', ') || 'no tasks';
}

const names = (ts: GateTask[]) => ts.map((t) => t.task).join(', ');

/** The verdict sentence. */
function verdict(r: GateResult): string {
  const allowed = r.tasks.filter((t) => t.allowed);
  const also = allowed.length ? `; allowed: ${names(allowed)}` : '';
  return r.ok
    ? `Gate passed: ${allowed.length ? 'no blocking regression' : 'nothing regressed'}${also}. ${tally(r)}.`
    : `Gate failed (blocking: ${names(r.tasks.filter((t) => t.blocking))}${also}). ${tally(r)}.`;
}

/** How the gate decides, in a sentence. */
function rule(r: GateResult): string {
  const by = r.tolerance ? ` by more than ${plural(r.tolerance, 'run')}` : '';
  return `A task or requirement regressed when fewer candidate runs passed than the baseline's pass rate predicts${by}, and improved when more did${by}; abstain counts as not passing.`;
}

const value = (v: Json | undefined, n: number) => (v === undefined ? 'nothing' : truncate(JSON.stringify(v), n));
const found = (e: GateEvidence[], n: number) =>
  e.length ? e.map((x) => `${x.locator ? `${x.locator} = ` : ''}${value(x.value, n)}`).join('; ') : 'nothing';

const findingTitle = (t: GateTask, f: GateFinding) => {
  const r = t.requirements.find((x) => x.id === f.requirement);
  return r ? `${t.task} ${r.id}` : `${t.task} (outcome)`;
};

/** The terminal table: changed tasks first, the reason for each regression, then the verdict. */
export function formatGate(r: GateResult, color = false): string {
  const head = ['', 'Task', 'Change', 'Success', 'Requirements'];
  const rows = r.tasks.map((t) => [
    mark(t),
    t.task,
    statusText(t),
    change(t.outcome.baseline, t.outcome.candidate),
    changedRequirements(t),
  ]);
  const out = [
    `${paint(color, 'bold', 'assay gate')}: ${headline(r)}`,
    '',
    ...alignTable(head, rows, {
      style: (s, ri, ci) => (ci === 0 ? paint(color, markStyle(rows[ri]![0]!), s) : s),
    }),
    '',
    'Success, Requirements: runs that passed of runs, baseline → candidate. Abstain counts as not passing.',
  ];
  const why: string[] = [];
  for (const t of r.tasks) {
    for (const f of t.findings) {
      const c = f.checks[0];
      const detail = c
        ? `${c.check} ${c.status}${c.reason ? ` (${c.reason})` : ''}: ${truncate(c.message, 120)}`
        : f.verdict;
      why.push(
        `${paint(color, f.allowed ? 'yellow' : 'red', f.allowed ? '!' : '✘')} ${findingTitle(t, f)}: ${detail}  (${f.run})`,
      );
    }
    if (t.status === 'missing')
      why.push(`${paint(color, t.allowed ? 'yellow' : 'red', t.allowed ? '!' : '✘')} ${t.task}: no candidate runs`);
  }
  if (why.length) out.push('', ...why);
  if (r.skipped.length)
    out.push('', ...r.skipped.map((s) => `${paint(color, 'yellow', '!')} skipped ${s.task}: ${s.reason}`));
  out.push('', paint(color, 'bold', paint(color, r.ok ? 'green' : 'red', verdict(r))));
  return out.join('\n');
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** A Markdown code span: delimited by one backtick more than the longest run in the text (CommonMark). */
const code = (s: string) => {
  const t = s.replace(/\n/g, ' ');
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((run) => run.length));
  if (!longest) return `\`${t}\``;
  const ticks = '`'.repeat(longest + 1);
  return `${ticks} ${t} ${ticks}`;
};
const countsLine = (c: GateCounts) =>
  `${c.pass} of ${c.runs} passed${c.fail ? `, ${c.fail} failed` : ''}${c.abstain ? `, ${c.abstain} abstained` : ''}`;

function requirementLine(q: GateRequirement): string {
  return `Baseline: ${countsLine(q.baseline!)}. Candidate: ${countsLine(q.candidate!)}.`;
}

function findingMarkdown(t: GateTask, f: GateFinding): string[] {
  const q = t.requirements.find((x) => x.id === f.requirement);
  const out = [
    `### ${md(t.task)}: ${q ? `${q.id} ${md(q.text)} (${q.kind})` : 'the outcome'}${f.allowed ? ' (allowed, not blocking)' : ''}`,
    '',
    q
      ? requirementLine(q)
      : `Baseline: ${countsLine(t.outcome.baseline!)} (succeeded). Candidate: ${countsLine(t.outcome.candidate!)}.`,
    '',
    `In ${code(f.run)} (${f.verdict.toUpperCase()})${f.runs.length > 1 ? `, and ${plural(f.runs.length - 1, 'other run')}: ${f.runs.slice(1).map(code).join(', ')}` : ''}:`,
    '',
  ];
  for (const c of f.checks) {
    out.push(`- **${md(c.check)}** ${md(c.description)}`);
    out.push(`  - Expected: ${code(truncate(c.expects, 300))}`);
    out.push(`  - Found: ${code(found(c.found, 200))}`);
    out.push(`  - Result: ${c.status}${c.reason ? ` (${c.reason})` : ''}: ${md(truncate(c.message, 300))}`);
    if (c.baseline) out.push(`  - Baseline found: ${code(found(c.baseline.found, 200))} in ${code(c.baseline.run)}`);
  }
  if (!f.checks.length) out.push('- No check failed; the requirement had no check to decide it (abstain).');
  out.push('');
  return out;
}

/** The Markdown report (`--markdown`): ready to post as a pull request comment. */
export function formatGateMarkdown(r: GateResult): string {
  const out = [
    '# Agent regression gate',
    '',
    `**${verdict(r)}**`,
    '',
    `Baseline: ${r.baseline.sources.map(code).join(', ')} (${plural(r.baseline.runs, 'run')}). Candidate: ${r.candidate.sources.map(code).join(', ')} (${plural(r.candidate.runs, 'run')}). ${rule(r)}${r.allow.length ? ` Allowed (reported, not blocking): ${r.allow.map(code).join(', ')}.` : ''}`,
    '',
    '| | Task | Change | Success | Requirements |',
    '|---|---|---|--:|---|',
    ...r.tasks.map(
      (t) =>
        `| ${mark(t)} | ${md(t.task)} | ${md(statusText(t))} | ${change(t.outcome.baseline, t.outcome.candidate)} | ${md(changedRequirements(t))} |`,
    ),
    '',
  ];
  const regressed = r.tasks.filter((t) => t.findings.length);
  if (regressed.length) {
    out.push('## Regressions', '');
    for (const t of regressed) for (const f of t.findings) out.push(...findingMarkdown(t, f));
  }
  const missing = r.tasks.filter((t) => t.status === 'missing');
  const added = r.tasks.filter((t) => t.status === 'new');
  if (missing.length || added.length) {
    out.push('## Tasks on one side', '');
    for (const t of missing)
      out.push(
        `- ${code(t.task)}: missing, no candidate runs (${t.outcome.baseline!.pass} of ${plural(t.outcome.baseline!.runs, 'baseline run')} succeeded)${t.allowed ? '; allowed' : '; a task the candidate did not run cannot be shown not to regress'}.`,
      );
    for (const t of added)
      out.push(
        `- ${code(t.task)}: new, ${t.outcome.candidate!.pass} of ${plural(t.outcome.candidate!.runs, 'candidate run')} succeeded.`,
      );
    out.push('');
  }
  if (r.skipped.length) {
    out.push('## Skipped', '');
    for (const s of r.skipped) out.push(`- ${code(s.task)}: ${md(s.reason)}`);
    out.push('');
  }
  return out.join('\n');
}

/** The result as stable JSON (`assay.gate/v1`). */
export function gateJson(r: GateResult): string {
  return JSON.stringify(r, null, 2);
}
