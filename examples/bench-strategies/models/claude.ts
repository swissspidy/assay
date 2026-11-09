/**
 * Claude Opus through Assay's own Anthropic adapter (`anthropicModel`, effort high, prompt
 * caching), the client `scripts/compile-examples.ts` recorded the `model` cassettes with, so
 * the `mine-first` recordings are made the same way and the rows compare like for like.
 *
 * Loaded only when a job runs live (it needs ANTHROPIC_API_KEY and @anthropic-ai/sdk). Re-record
 * the mine-first cassettes from the repository root:
 *   node src/cli/index.ts bench -c examples/bench-strategies/assay.config.ts --discovery mine-first --record
 */
import { anthropicModel } from '../../../src/model/index.ts';

export default await anthropicModel({ model: 'claude-opus-5-5' });
