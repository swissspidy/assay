/**
 * Scoped capture measurements (ADR 0025).
 *
 *   node scripts/scoped-capture.ts [--live] [--executable-path <chromium>] [--repeat N]
 *
 * Size: every real-app run (eval/real/runs), scoped to its task's compiled check set; the JSON
 * and gzipped bytes of the full and the scoped snapshot, the time to digest, write and parse
 * each, and that `verify` gives the same outcome (but for the snapshot digest).
 *
 * `--live`: capture time on the example apps. Each task's correct scenario is played once per
 * round in a fresh context, then the same page is captured full and scoped (alternating which
 * goes first); the medians over all rounds are reported per app.
 */
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { CheckSet, EvidenceSnapshot, Outcome } from '../src/index.ts';
import { scopeSnapshot, snapshotDigest, verify } from '../src/index.ts';
import { compiledFile, realApps, realRuns, realTasks } from '../eval/real/dataset.ts';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    'executable-path': { type: 'string' },
    repeat: { type: 'string' },
  },
});

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 : 0;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const time = (f: () => unknown, n = 5) => {
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    f();
    ts.push(performance.now() - t0);
  }
  return median(ts);
};
const sansDigest = (o: Outcome) => JSON.stringify({ ...o, snapshot: { ...o.snapshot, digest: '' } });

// --- Size, on the real-app runs ---------------------------------------------------------

const rows: {
  full: number;
  scoped: number;
  fullGz: number;
  scopedGz: number;
  digestFull: number;
  digestScoped: number;
  parseFull: number;
  parseScoped: number;
}[] = [];
let same = 0;
for (const app of realApps()) {
  for (const task of realTasks(app)) {
    const f = compiledFile(app, task, 'checks');
    if (!existsSync(f)) continue;
    const cs = JSON.parse(readFileSync(f, 'utf8')) as CheckSet;
    for (const run of realRuns(app, task)) {
      const full = run.snapshot as EvidenceSnapshot;
      const scoped = scopeSnapshot(full, cs);
      const fj = JSON.stringify(full);
      const sj = JSON.stringify(scoped);
      rows.push({
        full: Buffer.byteLength(fj),
        scoped: Buffer.byteLength(sj),
        fullGz: gzipSync(fj).length,
        scopedGz: gzipSync(sj).length,
        digestFull: time(() => snapshotDigest(full)),
        digestScoped: time(() => snapshotDigest(scoped)),
        parseFull: time(() => JSON.parse(fj)),
        parseScoped: time(() => JSON.parse(sj)),
      });
      if (sansDigest((await verify(cs, full)).outcome) === sansDigest((await verify(cs, scoped)).outcome)) same++;
    }
  }
}
const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
const pct = (a: number, b: number) => `${(100 * (1 - a / b)).toFixed(1)}%`;
const col = (k: keyof (typeof rows)[number]) => rows.map((r) => r[k]);
console.log(
  `Real-app runs: ${rows.length}; same outcome (but the digest) as the full snapshot: ${same}/${rows.length}`,
);
console.log('| | Full | Scoped | Saved |');
console.log('|---|---:|---:|---:|');
console.log(
  `| JSON, total | ${kb(sum(col('full')))} | ${kb(sum(col('scoped')))} | ${pct(sum(col('scoped')), sum(col('full')))} |`,
);
console.log(
  `| JSON, median run | ${kb(median(col('full')))} | ${kb(median(col('scoped')))} | ${pct(median(col('scoped')), median(col('full')))} |`,
);
console.log(
  `| gzip, total | ${kb(sum(col('fullGz')))} | ${kb(sum(col('scopedGz')))} | ${pct(sum(col('scopedGz')), sum(col('fullGz')))} |`,
);
console.log(
  `| digest, median run | ${median(col('digestFull')).toFixed(3)} ms | ${median(col('digestScoped')).toFixed(3)} ms | ${pct(median(col('digestScoped')), median(col('digestFull')))} |`,
);
console.log(
  `| JSON.parse, median run | ${median(col('parseFull')).toFixed(3)} ms | ${median(col('parseScoped')).toFixed(3)} ms | ${pct(median(col('parseScoped')), median(col('parseFull')))} |`,
);

// --- Capture time, live on the example apps ---------------------------------------------

if (values.live) {
  const { chromium } = await import('@playwright/test');
  const { EvidenceRecorder, captureBaseline, captureScopedSnapshot, captureSnapshot } =
    await import('../src/playwright/index.ts');
  const { APPS } = await import('../examples/apps.ts');
  const { play } = await import('../examples/lib/scenario.ts');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  /** The app's server on its own port (app-runner.ts starts a browser of its own, which --executable-path cannot reach). */
  const startServer = async (app: (typeof APPS)[number]) => {
    const port = app.port + 300;
    const server = spawn(process.execPath, [fileURLToPath(new URL('server.mjs', app.dir))], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    const baseURL = `http://localhost:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${baseURL}/`)).status < 500) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { baseURL, close: async () => void server.kill() };
  };
  const repeat = Number(values.repeat ?? 3);
  const exe = values['executable-path'];
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  console.log('\n| App | Captures | Full, median | Scoped, median | Saved |');
  console.log('|---|---:|---:|---:|---:|');
  try {
    for (const app of APPS) {
      const runner = await startServer(app);
      const fullMs: number[] = [];
      const scopedMs: number[] = [];
      try {
        for (let round = 0; round < repeat; round++) {
          for (const task of app.tasks) {
            const f = new URL(`compiled/${task.id}.checks.json`, app.dir);
            if (!existsSync(f)) continue;
            const cs = JSON.parse(readFileSync(f, 'utf8')) as CheckSet;
            const scenario = task.scenarios.find((s) => s.expected === 'success');
            if (!scenario) continue;
            const context = await browser.newContext({ baseURL: runner.baseURL });
            try {
              await EvidenceRecorder.attach(context);
              const page = await context.newPage();
              await play(scenario, page, (p) => captureBaseline(p, { probes: app.probes(p) }));
              const full = async () => {
                const t0 = performance.now();
                await captureSnapshot(page, { probes: app.probes(page) });
                fullMs.push(performance.now() - t0);
              };
              const scoped = async () => {
                const t0 = performance.now();
                await captureScopedSnapshot(page, cs, { probes: app.probes(page) });
                scopedMs.push(performance.now() - t0);
              };
              if (round % 2) {
                await scoped();
                await full();
              } else {
                await full();
                await scoped();
              }
            } finally {
              await context.close();
            }
          }
        }
      } finally {
        await runner.close();
      }
      console.log(
        `| ${app.name} | ${fullMs.length} | ${median(fullMs).toFixed(1)} ms | ${median(scopedMs).toFixed(1)} ms | ${pct(median(scopedMs), median(fullMs))} |`,
      );
    }
  } finally {
    await browser.close();
  }
}
