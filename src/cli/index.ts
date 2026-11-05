#!/usr/bin/env node
/** The `assay` executable (package.json `bin`). */
import { run } from './main.ts';

process.exitCode = await run(process.argv.slice(2));
