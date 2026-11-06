---
'@swissspidy/assay': minor
---

Bring your own model, configured once in `assay.config.ts` (`npx assay init` writes one). `model` takes a `'provider:model'` string (resolved through the provider's AI SDK package, with an error naming the package to install), any Vercel AI SDK model, or your own `{ id, turn(request) }` adapter. Models without tool calling are driven in JSON mode, with schema validation and one repair retry; AI SDK models fall back to it when the provider reports no tool support, and records and reports say `modes: ["json"]`. Every command and `compileTask` / `verify` read the config (`checks`, `snapshots`, `recordDir`, `escalate`, `requireLocked`, `trustedKeys`, `stress`); flags win over environment variables, which win over the config. Commands that need no model never load one. Existing cassettes replay unchanged.

```ts
import { defineConfig } from '@swissspidy/assay';

export default defineConfig({ model: 'anthropic:claude-opus-5-5', checks: 'checks' });
```
