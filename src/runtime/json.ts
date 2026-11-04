/** JSON helpers shared by the runtime: compiled JSON Schemas and RFC 6901 pointers. */
import { Ajv, type ValidateFunction } from 'ajv';
import type { Json, JsonSchema } from '../types.ts';
import { canonicalJson } from '../snapshot/digest.ts';

const ajv = new Ajv({ allErrors: false, strict: false, validateFormats: false });
const schemaCache = new Map<string, ValidateFunction>();

export function compileSchema(schema: JsonSchema): ValidateFunction {
  const key = canonicalJson(schema);
  let fn = schemaCache.get(key);
  if (!fn) {
    fn = ajv.compile(schema as object | boolean);
    schemaCache.set(key, fn);
  }
  return fn;
}

export function schemaErrors(fn: ValidateFunction): string {
  return ajv.errorsText(fn.errors, { separator: '; ' });
}

/** RFC 6901 JSON Pointer. Returns undefined if the path does not exist. */
export function jsonPointer(doc: Json | undefined, pointer: string | undefined): Json | undefined {
  if (pointer === undefined || pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  let cur: Json | undefined = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else if (cur && typeof cur === 'object') {
      cur = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : undefined;
    } else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}
