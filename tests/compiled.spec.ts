/**
 * Milestone 2 acceptance on the committed compiler output (if present):
 * every compiled check set is valid, every check traces to task text, and it
 * judges every labelled reference run correctly.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { canonical, evaluate, validateCheckSet, type CheckSet } from '../src/index.ts';

const root = new URL('../examples/tiny-shop/', import.meta.url);
const dir = new URL('compiled/', root);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.checks.json')) : [];

test('compiled check sets are present', () => {
  test.skip(files.length === 0, 'No compiled output yet: run scripts/compile-tiny-shop.ts with ANTHROPIC_API_KEY.');
  expect(files.length).toBe(10);
});

for (const f of files) {
  const id = f.replace('.checks.json', '');
  test(`compiled ${id}: valid, traceable, correct on all labelled runs`, () => {
    const cs = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as CheckSet;
    expect(validateCheckSet(cs).errors).toEqual([]);
    const fold = (s: string) => canonical(s).toLowerCase();
    for (const c of cs.checks) {
      const r = cs.requirements.find((x) => x.id === c.requirement)!;
      const src = r.source.field === 'instruction' ? cs.task.instruction : cs.task.outcomes!;
      expect(fold(src), `${c.id} → ${r.id} quote`).toContain(fold(r.source.quote));
    }
    const refDir = new URL(`references/${id}/`, root);
    for (const rf of readdirSync(refDir)) {
      const { label, snapshot } = JSON.parse(readFileSync(new URL(rf, refDir), 'utf8'));
      expect(evaluate(cs, snapshot).verdict, rf).toBe(label.expected);
    }
  });
}
