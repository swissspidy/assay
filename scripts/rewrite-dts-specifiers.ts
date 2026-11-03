/**
 * tsrs rewrites relative `.ts` import specifiers to `.js` in emitted JavaScript,
 * but some declaration files keep `.ts`. Consumers on TypeScript versions that
 * reject `.ts` specifiers in .d.ts files would then fail, so normalize them.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SPECIFIER = /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.d.ts') ? [p] : [];
  });
}

let changed = 0;
for (const file of walk(process.argv[2] ?? 'dist')) {
  const src = readFileSync(file, 'utf8');
  const out = src.replace(SPECIFIER, '$1$2.js$3');
  if (out !== src) {
    writeFileSync(file, out);
    changed++;
  }
}
console.warn(`rewrite-dts-specifiers: ${changed} file(s) updated`);
