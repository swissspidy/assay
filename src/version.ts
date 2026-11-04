import { createRequire } from 'node:module';

/** Names this package and its version (from package.json, so a release bump keeps it current). */
export const ASSAY_VERSION = `assay/${(createRequire(import.meta.url)('../package.json') as { version: string }).version}`;
