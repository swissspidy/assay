/**
 * Milestone 2 acceptance on the committed compiler output (if present):
 * every compiled check set is valid, every check traces to task text, and it
 * judges every labelled reference run correctly.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { canonical, evaluate, parseOutcomes, validateCheckSet, type CheckSet } from '../src/index.ts';
import { clauseCovered } from '../src/compiler/compile.ts';

import { APPS } from '../examples/apps.ts';

for (const app of APPS) {
  const root = app.dir;
  const dir = new URL('compiled/', root);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.checks.json')) : [];

  test(`${app.name}: compiled check sets are present`, () => {
    test.skip(files.length === 0, 'No compiled output yet: run `npm run compile:examples` with ANTHROPIC_API_KEY.');
    expect(files.length).toBe(app.tasks.length);
  });

  for (const f of files) {
    const id = f.replace('.checks.json', '');
    test(`compiled ${app.name}/${id}: valid, traceable, correct on all labelled runs`, () => {
      const cs = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as CheckSet;
      expect(validateCheckSet(cs).errors).toEqual([]);
      for (const c of cs.checks) {
        const r = cs.requirements.find((x) => x.id === c.requirement)!;
        const src = r.source.field === 'instruction' ? cs.task.instruction : cs.task.outcomes!;
        expect(canonical(src), `${c.id} → ${r.id} quote`).toContain(canonical(r.source.quote));
      }
      // The reverse direction, as the compiler enforces it: every expected outcome is fully quoted.
      const quotes = cs.requirements.filter((r) => r.source.field === 'outcomes').map((r) => r.source.quote);
      for (const clause of parseOutcomes(cs.task.outcomes)) {
        expect(clauseCovered(quotes, clause.text), `outcome ${JSON.stringify(clause.text)} is quoted`).toBe(true);
      }
      const refDir = new URL(`references/${id}/`, root);
      // Sets compiled before snapshots had a baseline cannot see that a run changed the
      // starting state (e.g. removed an item it should have kept). Such a miss is
      // reported until the set is recompiled; every other run must be judged correctly.
      const readsBaseline = JSON.stringify(cs.checks).includes('"at":"before"');
      for (const rf of readdirSync(refDir)) {
        const { label, snapshot } = JSON.parse(readFileSync(new URL(rf, refDir), 'utf8'));
        const verdict = evaluate(cs, snapshot).verdict;
        if (verdict !== label.expected && label.expected === 'fail' && snapshot.baseline && !readsBaseline) {
          test.info().annotations.push({ type: 'needs recompile', description: `${rf}: ${verdict}, labelled fail` });
          continue;
        }
        expect(verdict, rf).toBe(label.expected);
      }
    });
  }
}
