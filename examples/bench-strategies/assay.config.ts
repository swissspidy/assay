/**
 * The strategy bench (ADR 0026): one model over three tiny-shop tasks with each discovery
 * strategy (ADR 0020), replayable offline.
 *
 *   ASSAY_MODEL_MODE=replay node src/cli/index.ts bench -c examples/bench-strategies/assay.config.ts
 *
 * `model` replays the recordings `scripts/compile-examples.ts` made for these tasks (copied to
 * `cassettes/<model>/<task>/run-1.json`); `mine-first` was recorded live with `--record`, with
 * the mining prompt and the same client (models/claude.ts), to
 * `cassettes/<model>/<task>/mine-first/run-1.json`; `mine-only` runs no model.
 */
import type { AssayConfig } from '../../src/index.ts';

const config: AssayConfig = {
  bench: {
    // The label names the cassette directory; the module is Assay's Anthropic adapter (models/claude.ts).
    models: [{ name: 'anthropic:claude-opus-5-5', model: './models/claude.ts' }],
    discovery: ['model', 'mine-first', 'mine-only'],
    tasks: 'tasks',
    references: '../tiny-shop/references',
    cassettes: 'cassettes',
  },
};

export default config;
