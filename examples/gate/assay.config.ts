/**
 * The fixture gate (ADR 0021): tiny-shop runs before and after an imagined agent change.
 *
 *   node src/cli/index.ts gate -c examples/gate/assay.config.ts --markdown examples/gate/REPORT.md
 *
 * Copies of the tiny-shop reference snapshots stand in for the agent's runs: 02-add-blue-mug
 * regresses (one candidate run adds the Red Mug), 07-express-order improves (the baseline placed
 * one standard order), 01-newsletter is unchanged and 09-gift-wrap is new. Exits 1.
 */
import type { AssayConfig } from '../../src/index.ts';

const config: AssayConfig = {
  checks: '../tiny-shop/tasks',
  gate: { baseline: 'baseline', candidate: 'candidate' },
};

export default config;
