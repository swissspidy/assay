/**
 * The fixture bench (ADR 0018): two models over two tiny-shop tasks, replayable offline.
 *
 *   ASSAY_MODEL_MODE=replay node src/cli/index.ts bench -c examples/bench/assay.config.ts
 *
 * Claude Opus replays the recordings `scripts/compile-examples.ts` made for these tasks (copied
 * here); the copycat adapter (models/copycat.ts) was recorded with `--record`.
 */
import type { AssayConfig } from '../../src/index.ts';

const config: AssayConfig = {
  bench: {
    models: ['anthropic:claude-opus-5-5', './models/copycat.ts'],
    tasks: 'tasks',
    references: '../tiny-shop/references',
    cassettes: 'cassettes',
  },
};

export default config;
