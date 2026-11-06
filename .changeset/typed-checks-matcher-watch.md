---
'@swissspidy/assay': minor
---

Write and run checks with less friction:

- **Check builder** (`@swissspidy/assay/checks`): `checks`, `req`, `node`, `network`, `probe`, `text`, `url`, `storage`, `contains`, `each`, `page`, `allOf`, `anyOf`, `like`, `norm` and friends return exactly the `assay.checks/v1` JSON, with types and completion. Every command takes a `*.checks.ts` module where it takes a `*.checks.json`; `assay checks print --ts <file>` prints a set as builder code (and `assay checks print <file.checks.ts>` as JSON).
- **Playwright matcher**: `await expect(page).toHaveCompleted(task, { timeout, verdict, escalate })` (and `.not`), from `@swissspidy/assay/playwright` (`expect`, or `assayMatchers` for `expect.extend`). It polls like a web-first assertion, reads `assay.config.ts`, attaches the outcome and snapshot, and fails with each requirement's verdict, each failing check's description, expected and received values, and where the evidence is.
- **`assay watch`**: re-validates changed check sets (JSON or TypeScript, and the modules they import) and re-verifies their runs as you edit, printing a table of verdicts with what changed since the last run; `--stress` also stress-tests changed sets, `--once` runs once for CI.

```ts
import { checks, like, network, probe, req } from '@swissspidy/assay/checks';

export default checks('Add a Blue Mug to my cart.', [
  req('R1', 'The cart has a Blue Mug', { quote: 'Add a Blue Mug' })
    .check(probe('cart', '/items').like([{ name: 'Blue Mug' }]))
    .check(network.post('/api/cart/items').requestBody(like({ sku: 'MUG-BLUE' })), { onMissing: 'abstain' }),
]);
```
