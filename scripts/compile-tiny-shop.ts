/**
 * Milestone 2 acceptance run: compiles every Tiny Shop task from its
 * instruction + "Then" clauses and ONE correct reference run, then checks the
 * compiled set against all labelled runs (the other runs are held out).
 *
 *   node scripts/compile-tiny-shop.ts [taskId...]
 *
 * Writes examples/tiny-shop/compiled/<task>.{checks,report,cassette}.json and SUMMARY.md.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compileTask, evaluate, type CheckSet, type EvidenceSnapshot } from '../src/index.ts';
import { TASKS } from '../examples/tiny-shop/scenarios.ts';
import { modelFromEnv } from './model-from-env.ts';

const root = new URL('../examples/tiny-shop/', import.meta.url);
const out = new URL('compiled/', root);
mkdirSync(out, { recursive: true });
const only = new Set(process.argv.slice(2));

interface Labelled {
  name: string;
  expected: 'success' | 'fail';
  snapshot: EvidenceSnapshot;
}

function references(taskId: string): Labelled[] {
  const dir = new URL(`references/${taskId}/`, root);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      return { name: f.replace(/\.json$/, ''), expected: j.label.expected, snapshot: j.snapshot };
    });
}

const rows: string[] = [];
let failures = 0;
for (const def of TASKS) {
  if (only.size && !only.has(def.id)) continue;
  const handwritten = JSON.parse(readFileSync(new URL(`tasks/${def.id}.checks.json`, root), 'utf8')) as CheckSet;
  const task = {
    id: `tiny-shop/${def.id}`,
    instruction: handwritten.task.instruction,
    outcomes: handwritten.task.outcomes,
  };
  const runs = references(def.id);
  const firstOk = def.scenarios.find((s) => s.expected === 'success')!;
  const reference = runs.find((r) => r.name === firstOk.name)!;

  // One failing task (no cassette, API error) must not stop the others; a live
  // recording is saved after every turn, so nothing already paid for is lost.
  let result: Awaited<ReturnType<typeof compileTask>>;
  try {
    const env = await modelFromEnv(new URL(`${def.id}.cassette.json`, out).pathname);
    result = await compileTask(task, [{ name: reference.name, kind: 'success', snapshot: reference.snapshot }], {
      model: env.model,
      log: (m) => console.warn(m),
    });
    console.warn(`${def.id}: model ${env.mode}`);
  } catch (e) {
    failures++;
    const reason = e instanceof Error ? e.message : String(e);
    rows.push(`| ${def.id} | not compiled: ${reason.replace(/\|/g, '\\|')} | | | |`);
    console.warn(`${def.id}: ${reason}`);
    continue;
  }
  const { checkSet, report } = result;
  writeFileSync(new URL(`${def.id}.report.json`, out), JSON.stringify(report, null, 2) + '\n');
  if (!checkSet) {
    failures++;
    rows.push(`| ${def.id} | not compiled: ${report.reason} | | | |`);
    continue;
  }
  writeFileSync(new URL(`${def.id}.checks.json`, out), JSON.stringify(checkSet, null, 2) + '\n');

  const heldOut = runs.filter((r) => r.name !== reference.name);
  const wrong = heldOut.filter((r) => evaluate(checkSet, r.snapshot).verdict !== r.expected);
  if (wrong.length) failures++;
  rows.push(
    `| ${def.id} | ${checkSet.requirements.length} | ${checkSet.checks.length} | ${report.coverage.map((c) => `${c.requirement}:${c.channels.join('+')}`).join(', ')} | ${heldOut.length - wrong.length}/${heldOut.length}${wrong.length ? ` (wrong: ${wrong.map((w) => w.name).join(', ')})` : ''} |`,
  );
  console.warn(
    `${def.id}: ${checkSet.checks.length} checks (${env.mode}), held-out ${heldOut.length - wrong.length}/${heldOut.length}`,
  );
}

if (!only.size) {
  writeFileSync(
    new URL('SUMMARY.md', out),
    [
      '# Compiled Tiny Shop checks',
      '',
      'Each task was compiled from its instruction, its "Then" clauses and one correct reference run.',
      'The remaining labelled runs were held out; the last column counts how many the compiled checks judge correctly.',
      '',
      '| Task | Requirements | Checks | Evidence per requirement | Held-out runs correct |',
      '|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n'),
  );
}
process.exitCode = failures ? 1 : 0;
