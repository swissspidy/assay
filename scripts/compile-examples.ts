/**
 * Compiles every example task (30 tasks in 3 apps) from its instruction + "Then"
 * clauses and ONE correct reference run, then judges all other labelled runs
 * with the compiled set (they are held out). Milestone 2 acceptance, and the
 * compiled check sets used by the evaluation (milestone 5).
 *
 *   node scripts/compile-examples.ts [app] [taskId...]
 *
 * Writes examples/<app>/compiled/<task>.{checks,report,cassette}.json and SUMMARY.md.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, type CheckSet, type EvidenceSnapshot } from '../src/index.ts';
import { compileTask } from '../src/compiler/index.ts';
import { APPS } from '../examples/apps.ts';
import { compileReference } from '../examples/lib/scenario.ts';
import { modelFromEnv } from './model-from-env.ts';

const [onlyApp, ...onlyTasks] = process.argv.slice(2);
const only = new Set(onlyTasks);

interface Labelled {
  name: string;
  expected: 'success' | 'fail';
  snapshot: EvidenceSnapshot;
}

function references(root: URL, taskId: string): Labelled[] {
  const dir = new URL(`references/${taskId}/`, root);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      return { name: f.replace(/\.json$/, ''), expected: j.label.expected, snapshot: j.snapshot };
    });
}

let failures = 0;
for (const app of APPS) {
  if (onlyApp && app.name !== onlyApp) continue;
  const root = app.dir;
  const out = new URL('compiled/', root);
  mkdirSync(out, { recursive: true });
  const rows: string[] = [];
  for (const def of app.tasks) {
    if (only.size && !only.has(def.id)) continue;
    const handwritten = JSON.parse(readFileSync(new URL(`tasks/${def.id}.checks.json`, root), 'utf8')) as CheckSet;
    const task = {
      id: `${app.name}/${def.id}`,
      instruction: handwritten.task.instruction,
      ...(handwritten.task.outcomes !== undefined ? { outcomes: handwritten.task.outcomes } : {}),
      ...(def.skipVariants ? { skipVariants: def.skipVariants } : {}),
    };
    // A failed attempt must not leave an earlier run's checks behind for the tests to read.
    rmSync(new URL(`${def.id}.checks.json`, out), { force: true });

    // One failing task (no cassette, API error) must not stop the others; a live
    // recording is saved after every turn, so nothing already paid for is lost.
    let result: Awaited<ReturnType<typeof compileTask>>;
    let mode: string;
    let runs: ReturnType<typeof references>;
    let reference: (typeof runs)[number];
    try {
      // Inside the try: a missing or unreadable reference fails this task, not the whole run.
      const firstOk = compileReference(def);
      runs = references(root, def.id);
      const found = runs.find((r) => r.name === firstOk.name);
      if (!found) throw new Error(`reference run "${firstOk.name}" not found`);
      reference = found;
      const env = await modelFromEnv(fileURLToPath(new URL(`${def.id}.cassette.json`, out)));
      result = await compileTask(task, [{ name: reference.name, kind: 'success', snapshot: reference.snapshot }], {
        model: env.model,
        provenance: env.provenance,
        log: (m) => console.warn(m),
      });
      env.save();
      mode = env.mode;
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
      `${def.id}: ${checkSet.checks.length} checks (${mode}), held-out ${heldOut.length - wrong.length}/${heldOut.length}`,
    );
  }

  if (!only.size) {
    writeFileSync(
      new URL('SUMMARY.md', out),
      [
        `# Compiled ${app.name} checks`,
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
}
process.exitCode = failures ? 1 : 0;
