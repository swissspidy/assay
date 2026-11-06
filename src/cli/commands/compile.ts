/** `assay compile <task> --reference <snapshot|dir>`: compile a check set with a model. */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import {
  compileTask,
  type CompileReport,
  type DiscoveryStrategy,
  type Reference,
  type TaskInput,
} from '../../compiler/index.ts';
import {
  CliError,
  EXIT,
  UsageError,
  list,
  paint,
  readCheckSetFile,
  readJson,
  readSnapshots,
  readText,
  toSnapshot,
  type Invocation,
  type Io,
} from '../io.ts';
import { selectModel } from '../model.ts';
import { isModuleFile } from '../../checks/load.ts';
import { cliConfig, fromConfig } from '../config.ts';

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
const LOOKS_LIKE_PATH = /\.(json|md|txt|feature|ts|mts|js|mjs)$/i;
/** A single word ending in a file extension: a file name, not task text, so a missing one is an error. */
const looksLikePath = (s: string) => LOOKS_LIKE_PATH.test(s) && !/\s/.test(s);
const str = (x: unknown) => (typeof x === 'string' ? x : undefined);

/**
 * The task: inline instruction text, a text file holding it, or a JSON file with a
 * task (`{ id, instruction, outcomes, skipVariants }`) or a check set (its `task`).
 */
export async function resolveTask(arg: string, values: Invocation['values']): Promise<TaskInput> {
  let task: Partial<TaskInput> = {};
  if (isFile(arg)) {
    const ext = extname(arg).toLowerCase();
    if (ext === '.json' || isModuleFile(arg)) {
      // A module (`*.checks.ts`, ADR 0019) is read like the JSON it exports.
      const j = (ext === '.json' ? readJson(arg, 'task') : await readCheckSetFile(arg, 'task')) as Record<
        string,
        unknown
      >;
      const t = (j && typeof j.task === 'object' ? j.task : j) as Record<string, unknown>;
      if (!t || typeof t.instruction !== 'string') {
        throw new CliError(`${arg} has no instruction: expected { "instruction", "outcomes"? } or a check set`);
      }
      const skip = Array.isArray(t.skipVariants)
        ? (t.skipVariants as unknown[]).filter((x) => typeof x === 'string')
        : [];
      task = {
        id: str(j.id) ?? str(t.id) ?? basename(arg, extname(arg)).replace(/\.checks$/, ''),
        instruction: t.instruction.trim(),
        ...(typeof t.outcomes === 'string' ? { outcomes: t.outcomes } : {}),
        ...(skip.length ? { skipVariants: skip } : {}),
      };
    } else {
      task = { id: basename(arg, extname(arg)), instruction: readText(arg, 'task').trim() };
    }
  } else if (looksLikePath(arg)) {
    throw new CliError(`task file not found: ${arg}`);
  } else {
    task = { id: 'task', instruction: arg.trim() };
  }
  const outcomes = str(values.outcomes);
  if (outcomes !== undefined) {
    if (isFile(outcomes)) task.outcomes = readText(outcomes, 'outcomes').trim();
    else if (looksLikePath(outcomes)) throw new CliError(`outcomes file not found: ${outcomes}`);
    else task.outcomes = outcomes;
  }
  if (typeof values.id === 'string') task.id = values.id;
  const skip = list(str(values['skip-variants']));
  if (skip.length) task.skipVariants = skip;
  if (!task.instruction) throw new UsageError('the task instruction is empty');
  return task as TaskInput;
}

function references(values: Invocation['values']): Reference[] {
  const refs: Reference[] = [];
  const add = (paths: string[] | undefined, negative: boolean) => {
    for (const f of (paths ?? []).flatMap(readSnapshots)) {
      const kind = negative || f.expected === 'fail' ? 'negative' : 'success';
      if (refs.some((r) => r.name === f.name)) throw new CliError(`two references are named "${f.name}"`);
      refs.push({ name: f.name, kind, snapshot: toSnapshot(f) });
    }
  };
  add(values.reference as string[] | undefined, false);
  add(values.negative as string[] | undefined, true);
  if (!refs.some((r) => r.kind === 'success')) {
    throw new UsageError('missing --reference <snapshot|dir>: at least one correct run');
  }
  return refs;
}

function summary(report: CompileReport, write: (line: string) => void, color: boolean): void {
  if (report.status === 'compiled') {
    const how = report.mining?.discovery === 'mined' ? ' by mining alone' : '';
    const by = report.model === 'none' ? ' (no model)' : ` with ${report.model}`;
    write(`${paint(color, 'green', '✔')} Compiled ${report.task}${how}${by}`);
    for (const c of report.coverage) {
      write(
        `    ${c.requirement} "${c.quote}": ${c.checks.join(', ') || 'no checks'} (${c.channels.join('+') || 'no evidence'}${c.trust ? `, trust ${c.trust}` : ''})`,
      );
    }
  } else {
    write(`${paint(color, 'red', '✘')} Refused to compile ${report.task}: ${report.reason ?? 'unknown reason'}`);
  }
  if (report.references.length) {
    write(`References: ${report.references.map((r) => `${r.name} (${r.kind}): ${r.verdict}`).join(', ')}`);
  }
  const m = report.mining;
  if (m) {
    const covered = m.requirements.filter((r) => r.status === 'covered').length;
    write(
      paint(
        color,
        'dim',
        `Mining: ${covered}/${m.requirements.length} requirements covered, ${m.survivors}/${m.candidates} candidates survived ${m.variants} variants, ${m.ms} ms.`,
      ),
    );
    if (report.status === 'compiled')
      for (const r of m.requirements.filter((x) => x.status === 'open'))
        write(`    ${r.requirement} (model): ${r.reason}`);
  }
  for (const w of report.warnings) write(`    ${paint(color, 'yellow', 'warning:')} ${w}`);
  const u = report.usage;
  write(
    paint(
      color,
      'dim',
      `Turns: ${report.turns.rubric} rubric, ${report.turns.discovery} discovery. Tokens: ${u.inputTokens} in, ${u.outputTokens} out.`,
    ),
  );
}

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const rubric = str(values.rubric);
  if (rubric !== undefined && rubric !== 'model' && rubric !== 'deterministic') {
    throw new UsageError(`--rubric must be "model" or "deterministic", got ${JSON.stringify(rubric)}`);
  }
  if (values['mine-first'] && values['mine-only'])
    throw new UsageError('--mine-first and --mine-only exclude each other');
  const task = await resolveTask(positionals[0]!, values);
  const refs = references(values);
  const loaded = await cliConfig(values, io);
  const discovery: DiscoveryStrategy = values['mine-only']
    ? 'mine-only'
    : values['mine-first']
      ? 'mine-first'
      : (fromConfig(() => loaded.config.compile?.discovery) ?? 'model');
  // Mining alone with the deterministic rubric needs no model (ADR 0020).
  const model =
    discovery === 'mine-only' && rubric === 'deterministic'
      ? undefined
      : await selectModel(values, io.env, loaded, 'compile');
  if (values.verbose) io.err(`Compiling ${task.id} with ${model ? `${model.model.id} (${model.mode})` : 'no model'}`);

  const { checkSet, report } = await compileTask(task, refs, {
    ...(model ? { model: model.model } : {}),
    config: false,
    ...(model?.provenance ? { provenance: model.provenance } : {}),
    ...(rubric ? { rubric } : {}),
    ...(discovery !== 'model' ? { discovery } : {}),
    ...(values.verbose ? { log: (m: string) => io.err(m) } : {}),
  });
  model?.save();

  const out = str(values.out);
  if (checkSet && out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(checkSet, null, 2) + '\n');
  }
  if (values.json) {
    io.out(
      JSON.stringify(
        { report, ...(checkSet && !out ? { checkSet } : {}), ...(checkSet && out ? { out } : {}) },
        null,
        2,
      ),
    );
  } else {
    // The check set goes to stdout unless --out is given; the summary goes wherever it does not.
    if (out) summary(report, io.out, io.color);
    else summary(report, io.err, io.errColor);
    if (checkSet && out) io.out(`Wrote ${out}`);
    else if (checkSet) io.out(JSON.stringify(checkSet, null, 2));
  }
  return checkSet ? EXIT.ok : EXIT.fail;
}
