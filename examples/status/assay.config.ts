/**
 * The `assay status` fixture (ADR 0022): twelve tiny-shop tasks, each stopped at a different
 * rung of the readiness ladder. Built by `node scripts/status-fixture.ts`; the expected table is
 * STATUS.txt.
 *
 *   node src/cli/index.ts status -c examples/status/assay.config.ts
 */
import type { AssayConfig } from '../../src/index.ts';

const config: AssayConfig = {
  checks: 'tasks',
  // Recent runs: snapshots/<task>/*.json.
  snapshots: 'snapshots',
  trustedKeys: ['keys'],
  // Labelled runs: runs/<task>/*.json (copied from tiny-shop), the default of `assay status -r`.
  bench: { references: 'runs' },
  status: { recentRuns: { last: 5 } },
};

export default config;
