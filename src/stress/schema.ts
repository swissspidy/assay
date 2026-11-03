/** JSON Schema–aware near misses: values that violate what a schema pins down. */
import type { Json, JsonSchema } from '../types.ts';
import { compileSchema } from '../runtime/compare.ts';
import { nearMiss } from './edit.ts';

type Schema = Record<string, unknown>;

/** A value satisfying a simple schema built from const/enum (for inserting forbidden items). */
export function exampleOf(schema: unknown): Json | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const sc = schema as Schema;
  if ('const' in sc) return sc.const as Json;
  if (Array.isArray(sc.enum) && sc.enum.length) return sc.enum[0] as Json;
  if (sc.type === 'string' && sc.pattern === undefined && sc.format === undefined)
    return 'x'.repeat(typeof sc.minLength === 'number' ? Math.max(1, sc.minLength) : 1);
  const props = sc.properties as Record<string, unknown> | undefined;
  if (props) {
    const o: Record<string, Json> = {};
    for (const [k, v] of Object.entries(props)) {
      const e = exampleOf(v);
      if (e !== undefined) o[k] = e;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return undefined;
}

/** A value outside an enum/const set, near the current one. */
function outside(set: Json[], current: Json): Json | undefined {
  const members = new Set(set.map((s) => JSON.stringify(s)));
  const inSet = (x: Json) => members.has(JSON.stringify(x));
  let v: Json | undefined = current;
  // One more step than the set has members, so integer near misses always leave it.
  for (let i = 0; i < Math.max(5, set.length + 1) && v !== undefined; i++) {
    v = nearMiss(v);
    if (v !== undefined && !inSet(v)) return v;
  }
  return undefined;
}

function raw(schema: unknown, value: Json): { what: string; value: Json }[] {
  if (!schema || typeof schema !== 'object') return [];
  const sc = schema as Schema;
  const out: { what: string; value: Json }[] = [];
  if ('const' in sc) {
    const v = outside([sc.const as Json], value);
    if (v !== undefined) out.push({ what: 'pinned value changed', value: v });
  }
  if (Array.isArray(sc.enum)) {
    const v = outside(sc.enum as Json[], value);
    if (v !== undefined) out.push({ what: 'value outside the allowed set', value: v });
  }
  if (typeof value === 'number') {
    if (typeof sc.minimum === 'number') out.push({ what: 'below the minimum', value: sc.minimum - 1 });
    if (typeof sc.exclusiveMinimum === 'number')
      out.push({ what: 'at the exclusive minimum', value: sc.exclusiveMinimum });
    if (typeof sc.maximum === 'number') out.push({ what: 'above the maximum', value: sc.maximum + 1 });
    if (typeof sc.exclusiveMaximum === 'number')
      out.push({ what: 'at the exclusive maximum', value: sc.exclusiveMaximum });
  }
  if (typeof value === 'string' && typeof sc.pattern === 'string') {
    out.push({ what: 'does not match the pattern', value: value.replace(/[\p{L}\p{N}]/gu, '#') });
  }
  if (Array.isArray(value)) {
    if (sc.contains) {
      const fn = compileSchema(sc.contains as JsonSchema);
      const kept = value.filter((x) => !fn(x));
      if (kept.length !== value.length) out.push({ what: 'required item missing', value: kept });
      const matching = value.filter((x) => fn(x));
      if (typeof sc.minContains === 'number' && matching.length >= sc.minContains && matching.length > 0) {
        out.push({ what: 'one required item fewer', value: [...kept, ...matching.slice(1)] });
      }
    }
    const not = sc.not as Schema | undefined;
    if (not?.contains) {
      const item = exampleOf(not.contains);
      if (item !== undefined)
        out.push({ what: `forbidden item ${JSON.stringify(item)} present`, value: [...value, item] });
    }
    if (sc.items && typeof sc.items === 'object' && value.length) {
      value.forEach((item, i) => {
        for (const v of raw(sc.items, item))
          out.push({ what: `item ${i}: ${v.what}`, value: value.map((x, j) => (j === i ? v.value : x)) });
      });
    }
    if (typeof sc.minItems === 'number' && value.length >= sc.minItems && sc.minItems > 0) {
      out.push({ what: 'too few items', value: value.slice(0, sc.minItems - 1) });
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of (sc.required as string[] | undefined) ?? []) {
      if (k in value) {
        const { [k]: _gone, ...rest } = value;
        out.push({ what: `required ${k} missing`, value: rest });
      }
    }
    const props = sc.properties as Record<string, unknown> | undefined;
    for (const [k, sub] of Object.entries(props ?? {})) {
      if (!(k in value)) continue;
      for (const v of raw(sub, value[k]!)) out.push({ what: `${k}: ${v.what}`, value: { ...value, [k]: v.value } });
    }
  }
  for (const combo of ['allOf', 'anyOf', 'oneOf'] as const) {
    const subs = sc[combo];
    if (Array.isArray(subs)) for (const sub of subs) out.push(...raw(sub, value));
  }
  return out;
}

/**
 * Near misses of `value` that violate `schema`. Every candidate is checked against
 * the schema, so only real violations are returned (deduplicated).
 */
export function schemaViolations(schema: unknown, value: Json): { what: string; value: Json }[] {
  let fn: ReturnType<typeof compileSchema>;
  try {
    fn = compileSchema(schema as JsonSchema);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  return raw(schema, value).filter((v) => {
    const k = JSON.stringify(v.value);
    if (seen.has(k) || fn(v.value)) return false;
    seen.add(k);
    return true;
  });
}
