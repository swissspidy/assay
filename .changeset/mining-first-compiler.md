---
'@swissspidy/assay': minor
---

Mining-first compiler: `compileTask(task, refs, { discovery: 'mine-first' })` (`assay compile --mine-first`, or `compile: { discovery }` in `assay.config.ts`) mines candidate checks from the reference runs without a model, evaluates them in one batch over the references, the baseline and the stress variants, and accepts them through the same gate as the discovery agent. Requirements mining settles cost no discovery turn; the agent gets only the open ones, seeded with the mined candidates (a new `mined_candidates` tool). `discovery: 'mine-only'` (`--mine-only`) never asks for checks and, with `rubric: 'deterministic'`, needs no model; it fails with a reason per requirement it cannot cover. A mined set records `compiled.discovery` (`'mined'` or `'mined+model'`) and the report a `mining` section. The default stays `'model'`, so existing compiles and cassettes replay unchanged.
