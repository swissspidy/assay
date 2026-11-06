/**
 * The `assay` command-line tool: argument parsing, help and dispatch. Each command's
 * module (and the library code it needs) is imported only when that command runs.
 */
import { createRequire } from 'node:module';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { CliError, EXIT, UsageError, paint, processIo, type Invocation, type Io, type Values } from './io.ts';

export { EXIT, type Invocation, type Values } from './io.ts';

/** What a command module exports. */
export interface CommandModule {
  run(inv: Invocation, io: Io): Promise<number>;
}

interface CommandDef {
  summary: string;
  usage: string;
  options: ParseArgsOptionsConfig;
  args: [min: number, max: number];
  help: string;
  load(): Promise<CommandModule>;
}

const MODEL_OPTIONS: ParseArgsOptionsConfig = {
  model: { type: 'string' },
  provider: { type: 'string' },
  cassette: { type: 'string' },
};

const MODEL_HELP = `Model (flags win over $ASSAY_PROVIDER / $ASSAY_MODEL, which win over \`model\` in assay.config.ts):
  --model <id>          "provider:model" (e.g. openai:gpt-5, ollama:llama3.1; needs \`ai\` and the
                        provider's AI SDK package), or a model id for --provider. Default: $ASSAY_MODEL,
                        else the config's model, else claude-opus-5-5 when ANTHROPIC_API_KEY is set
  --provider <name>     For a bare --model id: anthropic (default; needs @anthropic-ai/sdk and
                        ANTHROPIC_API_KEY) or ai-sdk (needs \`ai\`; the id goes to the AI SDK's default
                        provider, e.g. "anthropic/claude-opus-5-5" through the AI Gateway). Default: $ASSAY_PROVIDER
  --cassette <file>     Replay model turns from this cassette if it exists, else record them to it.
                        ASSAY_MODEL_MODE=replay never calls a model; ASSAY_MODEL_MODE=record re-records.`;

const TRUSTED_KEY_OPTION: ParseArgsOptionsConfig = { 'trusted-key': { type: 'string', multiple: true } };

const TRUSTED_KEY_HELP = `  --trusted-key <path>   An Ed25519 public key (PEM) whose approvals are trusted, or a directory
                         of .pem files (repeatable). Also: $ASSAY_TRUSTED_KEYS (PEM text)`;

export const COMMANDS: Record<string, CommandDef> = {
  init: {
    summary: 'Create assay.config.ts: the model and the project defaults',
    usage: 'assay init [options]',
    args: [0, 0],
    options: { force: { type: 'boolean' } },
    help: `Writes assay.config.ts in the current directory with sensible defaults and, in comments,
the three ways to name a model: a "provider:model" string, any Vercel AI SDK model, or your
own adapter. Asks nothing.

Options:
  --force   Replace an existing assay.config.ts
  --json    Print { file } as JSON

Exit status: 0 created, 3 usage, 4 error (including a config file that already exists).`,
    load: () => import('./commands/init.ts'),
  },
  compile: {
    summary: 'Compile a check set from a task and reference snapshots',
    usage: 'assay compile <task> --reference <snapshot|dir> [options]',
    args: [1, 1],
    options: {
      reference: { type: 'string', multiple: true, short: 'r' },
      negative: { type: 'string', multiple: true },
      out: { type: 'string', short: 'o' },
      id: { type: 'string' },
      outcomes: { type: 'string' },
      rubric: { type: 'string' },
      'skip-variants': { type: 'string' },
      verbose: { type: 'boolean' },
      ...MODEL_OPTIONS,
    },
    help: `<task> is the instruction text, a text file with it, or a JSON file: a task
({ "id", "instruction", "outcomes", "skipVariants" }) or a check set, whose task is recompiled.

Options:
  -r, --reference <path>   A correct run: a snapshot file, or a directory of them (repeatable).
                           A labelled run ({ "label": { "expected": "fail" }, "snapshot" }) is a negative.
  --negative <path>        An incorrect run the checks must not pass (repeatable)
  -o, --out <file>         Write the check set here (default: stdout)
  --id <id>                Task id (default: from the JSON file, else the file name, else "task")
  --outcomes <text|file>   Expected outcomes: Gherkin "Then" steps, a Markdown list or plain lines
  --rubric <kind>          model (default) or deterministic (one hard requirement per outcome)
  --skip-variants <ids>    Comma-separated stress variants that do not apply to this task
  --verbose                Print the compiler's progress to stderr
  --json                   Print the compile report (and the check set, without --out) as JSON

${MODEL_HELP}

Exit status: 0 compiled, 1 refused (the reason and warnings are printed), 3 usage, 4 error.`,
    load: () => import('./commands/compile.ts'),
  },
  verify: {
    summary: 'Run a check set against a snapshot',
    usage: 'assay verify <checks.json> <snapshot.json> [options]',
    args: [2, 2],
    options: {
      escalate: { type: 'boolean' },
      record: { type: 'string' },
      'require-locked': { type: 'boolean' },
      'require-signed': { type: 'boolean' },
      ...TRUSTED_KEY_OPTION,
      'agent-report': { type: 'string' },
      ...MODEL_OPTIONS,
    },
    help: `Prints each requirement and check with its status and evidence.

Options:
  --escalate             Send requirements the checks abstained on to the agentic verifier
  --record <dir>         Write the outcome record (with the snapshot and check set) under <dir>
  --require-locked       Refuse a check set that is not approved (or was edited after approval)
  --require-signed       Also require the approval to be signed by a trusted key
${TRUSTED_KEY_HELP}
  --agent-report <text>  What the agent said it did (recorded as a claim, never evidence)
  --json                 Print { verdict, outcome, ... } as JSON

${MODEL_HELP}

Exit status: 0 success, 1 fail, 2 abstain, 3 usage, 4 error.`,
    load: () => import('./commands/verify.ts'),
  },
  stress: {
    summary: 'Stress-test a check set against variants and mutants of correct runs',
    usage: 'assay stress <checks.json> --reference <snapshot|dir> [options]',
    args: [1, 1],
    options: {
      reference: { type: 'string', multiple: true, short: 'r' },
      'skip-variants': { type: 'string' },
      claims: { type: 'boolean' },
    },
    help: `Edits each correct run into valid variants the checks must still accept and near-miss
mutants they must reject, and reports over-constrained, fragile and weak checks and missed mutants.

Options:
  -r, --reference <path>  A correct run, or a directory of runs (labelled incorrect runs are skipped)
  --skip-variants <ids>   Comma-separated variant ids that do not apply to this task (e.g. reorder)
  --no-claims             Do not re-run rejected mutants with a success claim added to the page
  --json                  Print the stress report as JSON

Exit status: 0 no problems, 1 problems found, 3 usage, 4 error.`,
    load: () => import('./commands/stress.ts'),
  },
  validate: {
    summary: 'Validate check sets (schema, semantics, loose matches, lock)',
    usage: 'assay validate [checks.json...] [options]',
    args: [0, Infinity],
    options: {
      strict: { type: 'boolean' },
      'require-locked': { type: 'boolean' },
      'require-signed': { type: 'boolean' },
      ...TRUSTED_KEY_OPTION,
    },
    help: `Without files, validates every check set the config's \`checks\` names.

Options:
  --strict               Treat warnings as problems (exit 1)
  --require-locked       Treat a set that is not approved, or was edited after approval, as a problem
  --require-signed       Also treat an approval not signed by a trusted key as a problem
${TRUSTED_KEY_HELP}
  --json                 Print one { file, ok, errors, warnings, lock } per file as JSON

Exit status: 0 valid, 1 invalid (or warnings with --strict, or not approved as required), 3 usage, 4 error.`,
    load: () => import('./commands/validate.ts'),
  },
  review: {
    summary: 'Print the review sheet: every check in plain language',
    usage: 'assay review <checks.json> [options]',
    args: [1, 1],
    options: {
      diff: { type: 'string' },
      format: { type: 'string' },
      stress: { type: 'string' },
      ...TRUSTED_KEY_OPTION,
    },
    help: `Prints each requirement with its quote and each check's description next to what it
mechanically tests and the evidence it reads, validation warnings, and the approval state.

Options:
  --diff <old.json>      The approved version: show what changed and which requirements to
                         re-review; unchanged requirements are listed without their checks
  --stress <report.json> A stress report (assay stress --json): rates, and findings per check
  --format <format>      markdown (default), github (Markdown with unchanged requirements
                         collapsed, for a PR comment) or html
${TRUSTED_KEY_HELP}
  --json                 Print the requirements and checks, warnings, lock and diff as JSON

Exit status: 0, 3 usage, 4 error (including an invalid check set).`,
    load: () => import('./commands/review.ts'),
  },
  approve: {
    summary: 'Approve a reviewed check set: lock it, signed with your key',
    usage: 'assay approve <checks.json> --reviewer <name> [--key <private.pem>] [options]',
    args: [1, 1],
    options: {
      reviewer: { type: 'string' },
      key: { type: 'string' },
      note: { type: 'string' },
      stress: { type: 'string' },
      out: { type: 'string', short: 'o' },
    },
    help: `Records that you read the review sheet (assay review) and confirm the checks: the lock holds
your name, the time, digests of the set and of each requirement and check, and an Ed25519
signature when a key is given. Any later edit breaks the lock. Rewrites the file unless --out is given.

Options:
  --reviewer <name>      Who approves (default: $ASSAY_REVIEWER)
  --key <file>           Ed25519 private key (PEM, from assay keygen) to sign with.
                         Default: $ASSAY_SIGNING_KEY (PEM text); without either the lock is unsigned
  --note <text>          A note kept in the lock
  --stress <report.json> The stress report you reviewed (assay stress --json); its digest is kept
  -o, --out <file>       Write the approved set here instead
  --json                 Print the lock as JSON

Exit status: 0 approved, 3 usage, 4 error (including an invalid check set or key).`,
    load: () => import('./commands/lock.ts'),
  },
  reject: {
    summary: 'Reject a proposed check set, with a note saying why',
    usage: 'assay reject <checks.json> --reviewer <name> --note <text> [options]',
    args: [1, 1],
    options: { reviewer: { type: 'string' }, note: { type: 'string' }, out: { type: 'string', short: 'o' } },
    help: `Records the rejection in the set (and removes a lock): verify --require-locked refuses it,
and assay review shows the note. A revised set is a proposal again.

Options:
  --reviewer <name>   Who rejects (default: $ASSAY_REVIEWER)
  --note <text>       Why (required)
  -o, --out <file>    Write the set here instead of rewriting it
  --json              Print the rejection as JSON

Exit status: 0 rejected, 3 usage, 4 error.`,
    load: () => import('./commands/lock.ts'),
  },
  unlock: {
    summary: 'Remove the approval (or rejection): the set is a proposal again',
    usage: 'assay unlock <checks.json> [options]',
    args: [1, 1],
    options: { out: { type: 'string', short: 'o' } },
    help: `Options:
  -o, --out <file>   Write the set here instead of rewriting it
  --json             Print the result as JSON

Exit status: 0, 3 usage, 4 error.`,
    load: () => import('./commands/lock.ts'),
  },
  keygen: {
    summary: 'Create an Ed25519 key pair for signing approvals',
    usage: 'assay keygen [--out <private.pem>] [options]',
    args: [0, 0],
    options: { out: { type: 'string', short: 'o' }, force: { type: 'boolean' } },
    help: `Prints the private and the public key (PEM), or writes them to files.

Options:
  -o, --out <file>   Write the private key here (mode 600) and the public key next to it
                     (alice.pem → alice.pub.pem)
  --force            Replace existing files
  --json             Print { keyId, ... } as JSON

Exit status: 0, 3 usage, 4 error.`,
    load: () => import('./commands/keygen.ts'),
  },
  bench: {
    summary: 'Compare models on your tasks: compile rate, check quality, tokens, cost, time',
    usage: 'assay bench [--model <model>...] [options]',
    args: [0, 0],
    options: {
      model: { type: 'string', multiple: true, short: 'm' },
      task: { type: 'string', multiple: true, short: 't' },
      tasks: { type: 'string' },
      references: { type: 'string' },
      runs: { type: 'string' },
      concurrency: { type: 'string' },
      record: { type: 'boolean' },
      cassettes: { type: 'string' },
      escalate: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
    },
    help: `Compiles each task with each model, as \`assay compile\` would, from the task's reference
runs, then stress-tests the check set and scores it on the task's other labelled runs. Prints one
row per model: tasks compiled, check sets with no stress problems, balanced accuracy and false
successes on the held-out runs, and turns, tokens, cost and model time per task. The best value
in each column is marked with *.

A task is a *.checks.json or *.task.json file ({ "id", "instruction", "outcomes",
"references": ["<run>"] }); its runs are <references>/<task name>/*.json, labelled
({ "label": { "expected": "success" | "fail" }, "snapshot" }) as in examples/*/references. It
compiles from the runs "references" names, else runs named reference or reference-*, else its
first correct run; the other labelled runs are held out.

Options:
  -m, --model <model>      A model to compare (repeatable): "provider:model" (e.g. openai:gpt-5),
                           or a module whose default export is a model or an adapter
                           (./my-adapter.ts). Default: \`bench.models\`, else the config's model
  -t, --task <glob>        Only these tasks, by name or file path (repeatable)
  --tasks <dir|glob>       The task files. Default: \`bench.tasks\`, else \`checks\`
  --references <dir>       One directory of runs per task. Default: \`bench.references\`, else
                           references/ next to the tasks directory
  --runs <n>               Compile each task n times per model: mean and standard deviation (default 1)
  --concurrency <n>        Compiles at once (default 2)
  --record                 Record every model's turns to cassettes (re-records existing ones)
  --cassettes <dir>        Cassette directory, one subdirectory per model. Default:
                           \`bench.cassettes\`, else assay-bench/. An existing cassette is replayed;
                           ASSAY_MODEL_MODE=replay never calls a model (CI)
  --escalate               Send held-out runs the checks abstain on to the same model as verifier
  -o, --out <file>         Also write a Markdown report
  --json                   Print the full result (every job) as JSON

A model that fails (missing package, API error, stale cassette) shows its error in its row; the
others go on. Ctrl-C prints what has finished.

Exit status: 0 done, 1 a model or compile errored, 3 usage, 4 error, 130 interrupted.`,
    load: () => import('./commands/bench.ts'),
  },
  capture: {
    summary: 'Capture an evidence snapshot of a URL with Playwright',
    usage: 'assay capture <url> [options]',
    args: [1, 1],
    options: {
      out: { type: 'string', short: 'o' },
      'wait-until': { type: 'string' },
      wait: { type: 'string' },
      storage: { type: 'boolean' },
      'executable-path': { type: 'string' },
    },
    help: `Opens the URL in headless Chromium, records the network from the start, and captures the
accessibility tree, text, network log and storage. Needs @playwright/test and its Chromium
(npx playwright install chromium).

Options:
  -o, --out <path>          A .json file, or a directory (file named after the host and time).
                            Default: print the snapshot to stdout
  --wait-until <event>      load (default), domcontentloaded or networkidle
  --wait <ms>               Wait this long after loading before capturing
  --no-storage              Leave cookies and web storage out
  --executable-path <file>  Chromium binary to use instead of Playwright's

Exit status: 0 captured, 3 usage, 4 error.`,
    load: () => import('./commands/capture.ts'),
  },
};

const COMMON: ParseArgsOptionsConfig = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  color: { type: 'boolean' },
  config: { type: 'string', short: 'c' },
};

export function version(): string {
  return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
}

export function mainHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  return `assay: compiled outcome verification for web agent tasks

Usage: assay <command> [options]

Commands:
${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`)
  .join('\n')}

Options:
  -h, --help           Show help (also: assay <command> --help)
  -v, --version        Show the version
  --json               Machine-readable output
  --no-color           No colour (also: NO_COLOR=1; colour is only used on a terminal)
  -c, --config <file>  The config file (default: assay.config.{ts,mts,js,mjs} in this directory).
                       Flags win over environment variables, which win over the config.

Exit status: 0 success, 1 fail or problems found, 2 abstain (inconclusive), 3 usage error, 4 other error.`;
}

export function commandHelp(name: string): string {
  const c = COMMANDS[name]!;
  return `${c.summary}.\n\nUsage: ${c.usage}\n\n${c.help}`;
}

export type Parsed = { kind: 'help'; command?: string } | { kind: 'version' } | ({ kind: 'run' } & Invocation);

/** Parse the arguments after `assay`. Throws UsageError. */
export function parse(argv: string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined) throw new UsageError('missing command');
  const noMore = (max: number) => {
    if (rest.length > max) throw new UsageError(`unexpected argument "${rest[max]}" after ${first}`);
  };
  if (first === '-h' || first === '--help') {
    noMore(0);
    return { kind: 'help' };
  }
  if (first === 'help') {
    noMore(1);
    if (rest[0] !== undefined && !Object.hasOwn(COMMANDS, rest[0]))
      throw new UsageError(`unknown command "${rest[0]}"`);
    return rest[0] ? { kind: 'help', command: rest[0] } : { kind: 'help' };
  }
  if (first === '-v' || first === '--version') {
    noMore(0);
    return { kind: 'version' };
  }
  const def = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (!def) {
    throw new UsageError(first.startsWith('-') ? `unknown option "${first}"` : `unknown command "${first}"`);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...COMMON, ...def.options },
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (e) {
    throw new UsageError((e as Error).message.replace(/\. To specify a positional argument.*$/s, ''));
  }
  const values = parsed.values as Values;
  if (values.help) return { kind: 'help', command: first };
  const n = parsed.positionals.length;
  const [min, max] = def.args;
  if (n < min) throw new UsageError(`missing argument (usage: ${def.usage})`);
  if (n > max) throw new UsageError(`unexpected argument "${parsed.positionals[max]}" (usage: ${def.usage})`);
  return { kind: 'run', command: first, values, positionals: parsed.positionals };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run the tool and return the exit status. */
export async function run(argv: string[], io: Io = processIo()): Promise<number> {
  // --color / --no-color apply to every message, including a usage error (the last one wins).
  const end = argv.indexOf('--');
  const colorFlag = (end === -1 ? argv : argv.slice(0, end)).findLast((a) => a === '--color' || a === '--no-color');
  if (colorFlag) {
    const on = colorFlag === '--color';
    io = { ...io, color: on, errColor: on };
  }
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    const cmd = argv[0] && Object.hasOwn(COMMANDS, argv[0]) ? ` ${argv[0]}` : '';
    io.err(`${paint(io.errColor, 'red', 'error:')} ${errorText(e)}\nRun "assay${cmd} --help" for usage.`);
    return EXIT.usage;
  }
  if (parsed.kind === 'help') {
    io.out(parsed.command ? commandHelp(parsed.command) : mainHelp());
    return EXIT.ok;
  }
  if (parsed.kind === 'version') {
    io.out(version());
    return EXIT.ok;
  }
  try {
    const mod = await COMMANDS[parsed.command]!.load();
    return await mod.run(parsed, io);
  } catch (e) {
    // The message only; ASSAY_DEBUG=1 adds the stack of an unexpected error.
    const text = io.env.ASSAY_DEBUG && !(e instanceof CliError) && e instanceof Error ? e.stack : errorText(e);
    io.err(`${paint(io.errColor, 'red', 'error:')} ${text}`);
    return e instanceof CliError ? e.code : EXIT.error;
  }
}
