import { expect, test } from '@playwright/test';
import { compileSchema } from '../../src/runtime/json.ts';
import { validateCheckSet } from '../../src/dsl/validate.ts';

test('compiled schemas stay correct across Ajv replacement, valid and invalid schemas alike', () => {
  const first = compileSchema({ type: 'object', properties: { a: { const: 0 } }, required: ['a'] });
  for (let i = 1; i < 2_500; i++) {
    compileSchema({ type: 'object', properties: { a: { const: i } } });
    if (i % 10 === 0) expect(() => compileSchema({ type: 'no-such-type' } as never)).toThrow();
  }
  expect(first({ a: 0 })).toBe(true);
  expect(first({})).toBe(false);
  const later = compileSchema({ type: 'integer', minimum: 3 });
  expect(later(3)).toBe(true);
  expect(later(2)).toBe(false);
  // The same schema still compiles (and validates) after the cache was cleared.
  const again = compileSchema({ type: 'object', properties: { a: { const: 0 } }, required: ['a'] });
  expect(again({ a: 0 })).toBe(true);
  expect(again({ a: 1 })).toBe(false);
});

test('the check-set validator keeps reporting invalid schemas after many compiles', () => {
  const set = (schema: unknown) => ({
    schema: 'assay.checks/v1',
    id: 'x',
    version: '1',
    task: { instruction: 'Submit the form.' },
    requirements: [{ id: 'R1', kind: 'hard', text: 'submitted', source: { field: 'instruction', quote: 'Submit' } }],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: 'sent',
        assert: { kind: 'request', match: { responseBody: schema } },
      },
    ],
  });
  for (let i = 0; i < 2_100; i++) validateCheckSet(set({ type: 'object', properties: { n: { const: i } } }));
  expect(validateCheckSet(set({ type: 'object' })).errors).toEqual([]);
  expect(validateCheckSet(set({ type: 'no-such-type' })).errors.join()).toContain('invalid JSON Schema');
});
