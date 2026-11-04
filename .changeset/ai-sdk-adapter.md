---
'@swissspidy/assay': minor
---

`aiSdkModel(model, options)` in `@swissspidy/assay/ai-sdk` runs the compiler and the agentic verifier on any Vercel AI SDK language model (`ai` 7 or later, an optional peer dependency). Assay's own tool loop keeps validating tool inputs, enforcing citations and recording cassettes; the AI SDK only makes each model call.

```ts
import { anthropic } from '@ai-sdk/anthropic'; // or any other AI SDK provider
import { aiSdkModel } from '@swissspidy/assay/ai-sdk';

const verifier = aiSdkModel(anthropic(process.env.ASSAY_MODEL!));
```
