# Contributing

## Setup

Node.js 24 or later (see `.nvmrc`). Tooling: [tsrs](https://github.com/oxc-project/tsrs) for
typechecking and builds, [oxlint](https://oxc.rs/docs/guide/usage/linter) and
[oxfmt](https://oxc.rs/docs/guide/usage/formatter) for linting and formatting.

```sh
npm install
npx playwright install --with-deps chromium
npm run check        # format, lint, typecheck, build and tests: what CI runs
npm test             # unit tests and live tests against the example apps (started automatically)
npm run test:pack    # the package as installed (needs the npm registry)
npm run format       # oxfmt --write
npm run shop         # run the Tiny Shop demo app on :4173
```

CI (`.github/workflows/ci.yml`) runs format, lint, typecheck and build, then the full test suite on
Node 24 and the latest Node release, the stability run and the evaluation (replayed), and
`npm run test:pack`, which packs the package, installs it into an empty project and uses every entry
point from there.

## Layout

- `src/`: the library. Each entry point in `package.json` `exports` has an `index.ts` (the root,
  `playwright/`, `compiler/`, `stress/`, `model/` for `/models`, `eval/`) or is a single module
  (`model/ai-sdk.ts` for `/ai-sdk`). `cli/` is the `assay` executable (`bin`).
- `examples/`: three small apps (Tiny Shop, Tiny Tracker, Tiny Calendar) with 30 tasks, handwritten
  and compiled check sets, and 126 labelled reference runs.
- `tests/`: unit tests (`tests/unit/`), live acceptance tests against the example apps, and the
  package test (`tests/pack/`). `tests/tasks.spec.ts` evaluates every Tiny Shop task live and on the
  serialized snapshot and asserts both give identical results.
- `scripts/`: the model-backed and long-running jobs below.
- `eval/`, `stability/`: committed results and cassettes. `eval/real/` holds the real-app evaluation
  ([ADR 0009](docs/adr/0009-real-site-evaluation.md)): app drivers, tasks and oracles, the browser
  agent, labelled runs and compiled check sets.

## Model-backed scripts

| Command                    | What it does                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run compile:examples` | Compiles the 30 example tasks from one correct run each and judges the held-out runs (`examples/<app>/compiled/`).                                                             |
| `npm run stress`           | Stress-tests the handwritten check sets (`examples/<app>/stress/handwritten/REPORT.md`).                                                                                       |
| `npm run eval`             | Compares checks, checks with escalation, an LLM judge and the agentic verifier (`eval/results/`). Add `-- --checks compiled` for the compiled sets (`eval/results/compiled/`). |
| `npm run stability`        | Judges every run against five simulated releases of each app with checks written for the first (`stability/results/REPORT.md`).                                                |
| `npm run references`       | Re-captures the labelled reference runs from the example apps.                                                                                                                 |
| `npm run eval:real`        | The same comparison on the real-app runs (`eval/results/real/`). Replays from stored snapshots: no app or browser needed. In CI.                                               |
| `npm run real:compile`     | Compiles the real-app tasks from their reference runs (`eval/real/compiled/`, `eval/results/real/COMPILE.md`).                                                                 |
| `npm run real:collect`     | Starts a real app in Docker (`forge`, `cms` or `shop`) and records labelled runs; `-- shop --check-oracles` self-tests the oracles. Needs Docker; agent runs need the key.     |

Model steps replay the committed cassettes, so these run without an API key. A missing cassette is
recorded when `ANTHROPIC_API_KEY` is set. `ASSAY_MODEL_MODE=replay` never calls a model;
`ASSAY_MODEL_MODE=record` re-records every cassette. Cassettes are keyed by a digest of the full
request and the model id, so any change to a prompt, a tool, the model or the Anthropic adapter's
request makes the replays fail: re-record them, and re-run the Model baselines workflow (run by
hand), which measures the model rows live with fresh recordings.

## Changesets

A pull request that changes what the package does (its API, the check DSL, verdicts, records,
reports) adds a changeset:

```sh
npm run changeset
```

Pick the bump: patch for a fix, minor for a feature. Assay is 0.x, so a breaking change is a minor
too. Then write the changelog entry for someone who uses the package: what changed for them, not how.
Commit the file it writes in [`.changeset/`](.changeset/README.md). A change to tests, docs, CI,
examples or scripts only needs none.

## Releases

The Release workflow gathers the changesets on `main` into a "Version packages" pull request. Merging
it stages that version on npm with npm's trusted publishing and provenance, then tags it and creates
its GitHub release. The version goes public once a maintainer approves the staged publish with 2FA on
npmjs.com. Any other push to `main` only updates the "Version packages" pull request. To reject a
staged version, reject the stage on npm and delete its tag and GitHub release; the next push stages
it again ([ADR 0006](docs/adr/0006-npm-package-and-releases.md)).

## Architecture decision records

Write an ADR ([`docs/adr`](docs/adr)) when a change makes a decision someone would later ask "why?"
about: a change to the check DSL or the snapshot or record formats, the trust boundary (what counts
as evidence), escalation, model providers, or how releases work. Number it after the last one.
